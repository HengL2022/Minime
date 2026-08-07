import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server as PublicSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  AuditDisposition,
  AuditSink,
  DurableResultAudit,
  ResultAuditRecord,
} from "../src/mcp/audit";
import { paramsHash } from "../src/mcp/audit";
import { AuditCoordinator } from "../src/mcp/audit-coordinator";
import { AuditedServerTransport, rawToolCallMeta } from "../src/mcp/audited-transport";
import { envelope } from "../src/mcp/envelope";
import { buildServer } from "../src/mcp/server";
import type { ToolDef } from "../src/mcp/tools/registry";

const sdkServer = new SdkMcpServer({ name: "h4-contract", version: "1.0.0" });
const publicServer: PublicSdkServer = sdkServer.server;
expect(typeof publicServer.getClientVersion).toBe("function");
void publicServer.getClientVersion();
// @ts-expect-error private/underscored SDK implementation fields are forbidden
void publicServer._server;

type Event = {
  phase: "attempt" | "result";
  actor: string;
  tool: string;
  params?: unknown;
  paramsHash?: string;
  ids?: string[];
  count?: number;
  error?: string;
  delivery?: "transport" | "direct";
  requestedNameHash?: string;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, timeoutMs = 500, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function quietWindow(timeoutMs = 25): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
}

class RecordingSink implements AuditSink {
  events: Event[] = [];
  failAttempt = false;
  failNextAttempt = false;
  failResult = false;
  failDisposition = false;
  attemptGate?: Promise<void>;
  resultDurableGate?: Promise<void>;
  attemptStarted?: (actor: string, tool: string) => void;
  resultSubmitted?: (actor: string, tool: string, record: ResultAuditRecord) => void;
  dispositionStarted?: (disposition: AuditDisposition) => void;
  dispositionGate?: Promise<void>;
  syncFailDisposition = false;
  dispositionAttempts = 0;
  dispositions: Array<{ resultEventId: string; disposition: AuditDisposition }> = [];
  private nextEventId = 1;

  async attempt(
    actor: string,
    tool: string,
    params: unknown,
    requestedNameHash?: string,
  ): Promise<string> {
    this.attemptStarted?.(actor, tool);
    await this.attemptGate;
    if (this.failAttempt) throw new Error("attempt failure");
    if (this.failNextAttempt) {
      this.failNextAttempt = false;
      throw new Error("one-shot attempt failure");
    }
    this.events.push({ phase: "attempt", actor, tool, params, requestedNameHash });
    return paramsHash(params);
  }

  private recordResult(
    actor: string,
    tool: string,
    paramsHash: string,
    ids: string[],
    count: number,
    error?: string,
    requestedNameHash?: string,
    delivery?: "transport" | "direct",
  ): void {
    if (this.failResult) throw new Error("result failure");
    this.events.push({
      phase: "result",
      actor,
      tool,
      paramsHash,
      ids: ids.slice(0, 100),
      count,
      error,
      requestedNameHash,
      delivery,
    });
  }

  async result(
    actor: string,
    tool: string,
    paramsHash: string,
    record: ResultAuditRecord,
    requestedNameHash?: string,
  ): Promise<DurableResultAudit> {
    this.resultSubmitted?.(actor, tool, record);
    await this.resultDurableGate;
    this.recordResult(
      actor,
      tool,
      paramsHash,
      record.returnedIds,
      record.returnedCount,
      record.error,
      requestedNameHash,
      record.delivery,
    );
    return { eventId: String(this.nextEventId++) };
  }

  disposition(
    _actor: string,
    _tool: string,
    resultEventId: string,
    disposition: AuditDisposition,
  ): Promise<void> {
    this.dispositionAttempts += 1;
    this.dispositionStarted?.(disposition);
    if (this.syncFailDisposition) throw new Error("raw synchronous disposition secret");
    return (async () => {
      await this.dispositionGate;
      if (this.failDisposition) throw new Error("raw disposition secret");
      this.dispositions.push({ resultEventId, disposition });
    })();
  }
}

class RecordingTransport implements Transport {
  readonly sent: Array<{ message: JSONRPCMessage; options?: TransportSendOptions }> = [];
  starts = 0;
  closes = 0;
  sendCalls = 0;
  failSend = false;
  syncFailSend = false;
  sendGate?: Promise<void>;
  sendStarted?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  async start(): Promise<void> {
    this.starts += 1;
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.sendCalls += 1;
    this.sendStarted?.(message);
    if (this.syncFailSend) throw new Error("raw synchronous transport secret");
    return (async () => {
      await this.sendGate;
      if (this.failSend) throw new Error("raw transport secret");
      this.sent.push({ message, options });
    })();
  }

  async close(): Promise<void> {
    this.closes += 1;
    this.onclose?.();
  }
}

const FICTIONAL_START_ERROR = "fictional transport start rejection";

class StartRejectingCloseGatedTransport implements Transport {
  readonly startEntered = deferred<void>();
  readonly closeEntered = deferred<void>();
  readonly closeGate = deferred<void>();
  starts = 0;
  closes = 0;
  retainedOnclose?: () => void;
  private closeNotified = false;
  private currentOnclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  get onclose(): (() => void) | undefined {
    return this.currentOnclose;
  }

  set onclose(callback: (() => void) | undefined) {
    this.currentOnclose = callback;
    if (callback) this.retainedOnclose = callback;
  }

  async start(): Promise<void> {
    this.starts += 1;
    this.startEntered.resolve();
    throw new Error(FICTIONAL_START_ERROR);
  }

  async send(_message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {}

  async close(): Promise<void> {
    this.closes += 1;
    this.closeEntered.resolve();
    await this.closeGate.promise;
    if (!this.closeNotified) {
      this.closeNotified = true;
      this.currentOnclose?.();
    }
  }

  fireRetainedClose(): void {
    this.retainedOnclose?.();
  }
}

class StartPendingTransport implements Transport {
  readonly startEntered = deferred<void>();
  readonly startGate = deferred<void>();
  readonly closeEntered = deferred<void>();
  readonly closeGate = deferred<void>();
  starts = 0;
  closes = 0;
  retainedOnclose?: () => void;
  private closeNotified = false;
  private currentOnclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  get onclose(): (() => void) | undefined {
    return this.currentOnclose;
  }

  set onclose(callback: (() => void) | undefined) {
    this.currentOnclose = callback;
    if (callback) this.retainedOnclose = callback;
  }

  async start(): Promise<void> {
    this.starts += 1;
    this.startEntered.resolve();
    await this.startGate.promise;
  }

  async send(_message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {}

  async close(): Promise<void> {
    this.closes += 1;
    this.closeEntered.resolve();
    await this.closeGate.promise;
    if (!this.closeNotified) {
      this.closeNotified = true;
      this.currentOnclose?.();
    }
  }

  fireRetainedClose(): void {
    this.retainedOnclose?.();
  }
}

function callMessage(id: string | number, name: unknown, args: unknown = {}): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

function fictionalTool(handler: ToolDef["handler"]): ToolDef {
  return {
    name: "fictional_tool",
    description: "fictional",
    schema: { value: z.string() },
    handler,
  };
}

async function initializeRawTransport(
  transport: Transport,
  responses: JSONRPCMessage[],
  clientName: string,
): Promise<void> {
  const initialized = deferred<JSONRPCMessage>();
  const previousOnMessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    responses.push(message);
    if ("id" in message && message.id === 1) initialized.resolve(message);
    previousOnMessage?.(message, extra);
  };
  await transport.start();
  await transport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    },
  });
  await within(initialized.promise, 500, "initialize response");
  await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

function setupAdapter(
  sink = new RecordingSink(),
  tools: readonly (ToolDef | string)[] = [],
): {
  inner: RecordingTransport;
  adapter: AuditedServerTransport;
  coordinator: AuditCoordinator;
  sink: RecordingSink;
} {
  const inner = new RecordingTransport();
  const coordinator = new AuditCoordinator(sink);
  const adapter = new AuditedServerTransport({
    inner,
    coordinator,
    actor: () => "agent:test-client",
    knownTools: new Set(tools.map((tool) => (typeof tool === "string" ? tool : tool.name))),
  });
  return { inner, adapter, coordinator, sink };
}

describe("H4 audited transport metadata", () => {
  test("extracts known, unknown, malformed, and task classifications without raw names", () => {
    const known = new Set(["fictional_tool"]);
    const knownCall = rawToolCallMeta(
      callMessage(0, "fictional_tool", { value: 1 }),
      "agent:test",
      known,
    );
    expect(knownCall).toMatchObject({
      requestId: 0,
      actor: "agent:test",
      tool: "fictional_tool",
      refusalClass: "known",
    });
    expect(knownCall?.paramsForAudit).toEqual({ value: 1 });

    const unknown = rawToolCallMeta(callMessage("u", "raw-secret-name", {}), "agent:test", known);
    expect(unknown).toMatchObject({ requestId: "u", tool: "unknown", refusalClass: "unknown" });
    expect(unknown?.requestedNameHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(unknown)).not.toContain("raw-secret-name");

    const malformedArgs = rawToolCallMeta(
      callMessage("m", "fictional_tool", []),
      "agent:test",
      known,
    );
    expect(malformedArgs).toMatchObject({ tool: "fictional_tool", refusalClass: "malformed" });

    const task = rawToolCallMeta(
      {
        ...callMessage("t", "fictional_tool", {}),
        params: { name: "fictional_tool", arguments: {}, task: { ttl: 30 } },
      },
      "agent:test",
      known,
    );
    expect(task).toMatchObject({ tool: "fictional_tool", refusalClass: "task" });

    const malformedTask = rawToolCallMeta(
      {
        ...callMessage("mt", "fictional_tool", {}),
        params: { name: "fictional_tool", arguments: {}, task: { ttl: "bad" } },
      },
      "agent:test",
      known,
    );
    expect(malformedTask).toMatchObject({ refusalClass: "malformed" });

    const nestedTask = rawToolCallMeta(
      {
        ...callMessage("n", "fictional_tool", { task: { ttl: "ordinary" }, value: "ok" }),
        params: { name: "fictional_tool", arguments: { task: { ttl: "ordinary" }, value: "ok" } },
      },
      "agent:test",
      known,
    );
    expect(nestedTask).toMatchObject({ refusalClass: "known" });
  });

  test("classifies every top-level task shape explicitly", () => {
    const known = new Set(["fictional_tool"]);
    const malformedTaskValues: unknown[] = [null, "queued", [], true, 7];
    for (const task of malformedTaskValues) {
      const meta = rawToolCallMeta(
        {
          ...callMessage(`malformed-task-${String(task)}`, "fictional_tool", {}),
          params: { name: "fictional_tool", arguments: {}, task },
        },
        "agent:test",
        known,
      );
      expect(meta?.refusalClass).toBe("malformed");
    }

    const validTask = rawToolCallMeta(
      {
        ...callMessage("valid-task", "fictional_tool", {}),
        params: { name: "fictional_tool", arguments: {}, task: {} },
      },
      "agent:test",
      known,
    );
    expect(validTask?.refusalClass).toBe("task");

    const numericTtl = rawToolCallMeta(
      {
        ...callMessage("numeric-ttl", "fictional_tool", {}),
        params: { name: "fictional_tool", arguments: {}, task: { ttl: 30 } },
      },
      "agent:test",
      known,
    );
    expect(numericTtl?.refusalClass).toBe("task");

    const invalidTtl = rawToolCallMeta(
      {
        ...callMessage("invalid-ttl", "fictional_tool", {}),
        params: { name: "fictional_tool", arguments: {}, task: { ttl: "30" } },
      },
      "agent:test",
      known,
    );
    expect(invalidTtl?.refusalClass).toBe("malformed");

    const nestedTask = rawToolCallMeta(
      {
        ...callMessage("nested-task", "fictional_tool", { task: { ttl: "ordinary" } }),
        params: {
          name: "fictional_tool",
          arguments: { task: { ttl: "ordinary" } },
        },
      },
      "agent:test",
      known,
    );
    expect(nestedTask?.refusalClass).toBe("known");
  });

  test("classifies omitted params as malformed unknown with the canonical empty hash", () => {
    const omitted = rawToolCallMeta(
      { jsonrpc: "2.0", id: "omitted", method: "tools/call" } as JSONRPCMessage,
      "agent:test",
      new Set(["fictional_tool"]),
    );
    expect(omitted).toMatchObject({
      requestId: "omitted",
      tool: "unknown",
      paramsForAudit: {},
      refusalClass: "malformed",
      requestedNameHash: "74234e98afe7498f",
    });
    expect(paramsHash(omitted?.paramsForAudit)).toBe("44136fa355b3678a");
  });

  test("classifies missing and numeric names as BAD_INPUT while valid unknown strings stay UNKNOWN_TOOL", () => {
    const known = new Set(["fictional_tool"]);
    const missing = rawToolCallMeta(
      { ...callMessage("missing", undefined, {}), params: { arguments: {} } } as JSONRPCMessage,
      "agent:test",
      known,
    );
    const numeric = rawToolCallMeta(
      { ...callMessage("numeric", 7, {}), params: { name: 7, arguments: {} } } as JSONRPCMessage,
      "agent:test",
      known,
    );
    const unknown = rawToolCallMeta(
      callMessage("unknown", "not_registered", {}),
      "agent:test",
      known,
    );
    expect(missing).toMatchObject({
      tool: "unknown",
      refusalClass: "malformed",
      requestedNameHash: "74234e98afe7498f",
    });
    expect(numeric).toMatchObject({
      tool: "unknown",
      refusalClass: "malformed",
      requestedNameHash: "7902699be42c8a8e",
    });
    expect(unknown).toMatchObject({ tool: "unknown", refusalClass: "unknown" });
  });

  test("recognizes only exact cancellation notifications and preserves ID zero", async () => {
    const { inner, adapter, coordinator } = setupAdapter();
    const forwarded: JSONRPCMessage[] = [];
    adapter.onmessage = (message) => forwarded.push(message);
    await adapter.start();
    const cancelZero: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 0 },
    };
    inner.onmessage?.(cancelZero);
    await Promise.resolve();
    expect(forwarded).toEqual([cancelZero]);
    expect(coordinator.pendingCount()).toBe(0);

    const lookalike: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      id: "r",
      params: { requestId: 0 },
    };
    inner.onmessage?.(lookalike);
    await Promise.resolve();
    expect(forwarded.at(-1)).toEqual(lookalike);
    expect(forwarded).toHaveLength(2);
  });

  test("forwards every malformed cancellation lookalike unchanged", async () => {
    const tool = fictionalTool(async () => envelope({}, []));
    const { inner, adapter, coordinator, sink } = setupAdapter(new RecordingSink(), [tool]);
    const forwarded: JSONRPCMessage[] = [];
    adapter.onmessage = (message) => forwarded.push(message);
    await adapter.start();
    inner.onmessage?.(callMessage("known", "fictional_tool", { value: "ok" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    inner.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "known" },
    });
    inner.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: true },
    } as unknown as JSONRPCMessage);
    inner.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: [],
    } as unknown as JSONRPCMessage);
    const inheritedParams = Object.create({ requestId: "known" }) as Record<string, unknown>;
    inheritedParams.reason = "inherited";
    inner.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: inheritedParams,
    } as unknown as JSONRPCMessage);
    inner.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
    } as unknown as JSONRPCMessage);
    inner.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      id: "lookalike",
      params: { requestId: "known" },
    });
    inner.onmessage?.({ jsonrpc: "2.0", method: "other", params: { requestId: "known" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      forwarded.map((message) =>
        "id" in message ? message.id : "method" in message ? message.method : "",
      ),
    ).toEqual([
      "known",
      "notifications/cancelled",
      "notifications/cancelled",
      "notifications/cancelled",
      "notifications/cancelled",
      "lookalike",
      "other",
    ]);
    expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(1);
    await coordinator.drain();
    await adapter.close();
  });

  test("owns only public-schema cancellations and never cancels on lookalikes", async () => {
    const { inner, adapter, coordinator, sink } = setupAdapter(new RecordingSink(), [
      "fictional_tool",
    ]);
    const forwarded: JSONRPCMessage[] = [];
    const cancelled: Array<string | number> = [];
    const cancel = coordinator.cancel.bind(coordinator);
    coordinator.cancel = async (requestId) => {
      cancelled.push(requestId);
      return cancel(requestId);
    };
    adapter.onmessage = (message) => forwarded.push(message);
    await adapter.start();

    inner.onmessage?.(callMessage("live", "fictional_tool", { value: "ok" }));
    inner.onmessage?.(callMessage(0, "fictional_tool", { value: "ok" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const validString = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "live" },
    } as JSONRPCMessage;
    const validZero = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 0 },
    } as JSONRPCMessage;
    inner.onmessage?.(validString);
    inner.onmessage?.(validZero);

    const inheritedParams = Object.create({ requestId: "live" }) as Record<string, unknown>;
    inheritedParams.reason = "inherited";
    const malformed: JSONRPCMessage[] = [
      {
        jsonrpc: "1.0",
        method: "notifications/cancelled",
        params: { requestId: "live" },
      } as unknown as JSONRPCMessage,
      {
        jsonrpc: "2.0",
        id: "response",
        method: "notifications/cancelled",
        params: { requestId: "live" },
      } as JSONRPCMessage,
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: inheritedParams,
      } as JSONRPCMessage,
      { jsonrpc: "2.0", method: "notifications/cancelled", params: {} } as JSONRPCMessage,
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: [],
      } as unknown as JSONRPCMessage,
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: true },
      } as unknown as JSONRPCMessage,
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: {} },
      } as unknown as JSONRPCMessage,
    ];
    for (const message of malformed) inner.onmessage?.(message);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cancelled).toEqual(["live", 0]);
    expect(forwarded).toEqual([
      callMessage("live", "fictional_tool", { value: "ok" }),
      callMessage(0, "fictional_tool", { value: "ok" }),
      ...malformed,
    ]);
    expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(2);
    await adapter.close();
    expect(coordinator.pendingCount()).toBe(0);
  });
});

describe("H4 audited server facade", () => {
  test("returns only connect and close and preserves the captured public schema", async () => {
    const server = buildServer();
    expect("server" in server).toBe(false);
    expect(Object.keys(server).sort()).toEqual(["close", "connect"]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "schema-test", version: "1.0.0" });
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools).toEqual(
      JSON.parse(
        await Bun.file(new URL("../fixtures/mcp-tools-list-sdk-1.29.json", import.meta.url)).text(),
      ),
    );
    await client.close();
    await server.close();
  });

  test("withholds an omitted-params SDK refusal until its BAD_INPUT audit is durable", async () => {
    const sink = new RecordingSink();
    let release!: () => void;
    sink.resultDurableGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = buildServer({ auditSink: sink });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const responses: JSONRPCMessage[] = [];
    clientTransport.onmessage = (message) => responses.push(message);
    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "omitted", version: "1" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await clientTransport.send({
      jsonrpc: "2.0",
      id: "omitted",
      method: "tools/call",
    } as JSONRPCMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      phase: "attempt",
      tool: "unknown",
      params: {},
      requestedNameHash: "74234e98afe7498f",
    });
    expect(paramsHash(sink.events[0]?.params)).toBe("44136fa355b3678a");
    expect(responses.some((message) => "id" in message && message.id === "omitted")).toBe(false);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sink.events).toHaveLength(2);
    expect(sink.events[1]).toMatchObject({
      phase: "result",
      tool: "unknown",
      paramsHash: "44136fa355b3678a",
      error: "BAD_INPUT",
      requestedNameHash: "74234e98afe7498f",
    });
    expect(responses.some((message) => "id" in message && message.id === "omitted")).toBe(true);

    sink.resultDurableGate = undefined;
    sink.failResult = true;
    await clientTransport.send({
      jsonrpc: "2.0",
      id: "omitted-fail",
      method: "tools/call",
    } as JSONRPCMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = responses.find((message) => "id" in message && message.id === "omitted-fail");
    expect(failed).toBeDefined();
    expect(JSON.stringify(failed)).toContain("AUDIT_UNAVAILABLE");
    expect(JSON.stringify(failed)).not.toContain("Invalid params");
    await clientTransport.close();
    await server.close();
  });

  test("attempt failure returns only ATTEMPT_FAILURE_RESULT and never reaches a registered handler", async () => {
    const sink = new RecordingSink();
    sink.failAttempt = true;
    let executed = false;
    const tool = fictionalTool(async () => {
      executed = true;
      return envelope({}, []);
    });
    const server = buildServer({ auditSink: sink, tools: [tool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const responses: JSONRPCMessage[] = [];
    clientTransport.onmessage = (message) => responses.push(message);
    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "attempt-failure", version: "1" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await clientTransport.send(callMessage(2, "fictional_tool", { value: "ok" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executed).toBe(false);
    expect(sink.events).toHaveLength(0);
    const failed = responses.find((message) => "id" in message && message.id === 2);
    expect(failed).toBeDefined();
    expect(JSON.stringify(failed)).toContain("Tool unavailable before execution");
    expect(JSON.stringify(failed)).not.toContain("fictional_tool");
    await clientTransport.close();
    await server.close();
  });

  test("fixed attempt, withheld-success, and audit-unavailable wire payloads are exact and opaque", async () => {
    const runRawCall = async (
      sink: RecordingSink,
      tool: ToolDef,
      args: Record<string, unknown>,
      clientName: string,
    ): Promise<JSONRPCMessage> => {
      const server = buildServer({ auditSink: sink, tools: [tool] });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const responses: JSONRPCMessage[] = [];
      await initializeRawTransport(clientTransport, responses, clientName);
      const responseEntered = deferred<JSONRPCMessage>();
      clientTransport.onmessage = (message) => {
        responses.push(message);
        if ("id" in message && message.id === 2) responseEntered.resolve(message);
      };
      await clientTransport.send(callMessage(2, tool.name, args));
      const response = await within(responseEntered.promise, 500, `${clientName} response`);
      await clientTransport.close();
      await server.close();
      return response;
    };

    const attemptSink = new RecordingSink();
    attemptSink.failAttempt = true;
    const attemptResponse = await runRawCall(
      attemptSink,
      fictionalTool(async () => envelope({}, [])),
      { value: "attempt-sentinel" },
      "wire-attempt-failure",
    );
    expect(attemptResponse).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: '{"error":{"code":"INTERNAL","message":"Tool unavailable before execution.","retry":true}}',
          },
        ],
      },
    });
    expect(JSON.stringify(attemptResponse)).not.toContain("attempt-sentinel");

    const withheldSink = new RecordingSink();
    withheldSink.failResult = true;
    const withheldResponse = await runRawCall(
      withheldSink,
      fictionalTool(async () =>
        envelope(
          {
            title: "ZQX-WIRE-TITLE",
            path: "ZQX-WIRE-PATH",
            value: "ZQX-WIRE-DATA",
          },
          [{ type: "note", id: "ZQX-WIRE-SOURCE" }],
        ),
      ),
      { value: "ZQX-WIRE-PARAMETER" },
      "wire-withheld-success",
    );
    expect(withheldResponse).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        isError: false,
        content: [
          {
            type: "text",
            text: '{"data":{"status":"completed_result_withheld","retry":false},"sources":[],"gaps":["completion audit unavailable; result withheld"]}',
          },
        ],
      },
    });
    expect(JSON.stringify(withheldResponse)).not.toMatch(
      /ZQX-WIRE-(TITLE|PATH|DATA|SOURCE|PARAMETER)/,
    );

    const unavailableSink = new RecordingSink();
    unavailableSink.failResult = true;
    const unavailableResponse = await runRawCall(
      unavailableSink,
      fictionalTool(async () => {
        throw new Error("ZQX-WIRE-ERROR");
      }),
      { value: "ZQX-WIRE-PARAMETER" },
      "wire-audit-unavailable",
    );
    expect(unavailableResponse).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: '{"error":{"code":"AUDIT_UNAVAILABLE","message":"Tool result withheld because completion audit is unavailable.","retry":false}}',
          },
        ],
      },
    });
    expect(JSON.stringify(unavailableResponse)).not.toMatch(/ZQX-WIRE-(ERROR|PARAMETER)/);
  });

  test("production task requests are refused before the handler on a non-task-capable facade", async () => {
    const sink = new RecordingSink();
    let executed = false;
    const tool = fictionalTool(async () => {
      executed = true;
      return envelope({ ok: true }, []);
    });
    const server = buildServer({ auditSink: sink, tools: [tool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const responses: JSONRPCMessage[] = [];
    clientTransport.onmessage = (message) => responses.push(message);
    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "task-client", version: "1" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await clientTransport.send({
      ...callMessage(2, "fictional_tool", { value: "ok" }),
      params: { name: "fictional_tool", arguments: { value: "ok" }, task: {} },
    } as JSONRPCMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executed).toBe(false);
    expect(sink.events.map((event) => event.phase)).toEqual(["attempt", "result"]);
    expect(sink.events[1]).toMatchObject({ tool: "fictional_tool", error: "SDK_REFUSAL" });
    expect(responses.some((message) => "id" in message && message.id === 2)).toBe(true);
    await clientTransport.close();
    await server.close();
  });

  test("real task-capable SDK keeps a failing refusal audit fail-closed and drains correlation", async () => {
    const sink = new RecordingSink();
    sink.failResult = true;
    const sdk = new SdkMcpServer(
      { name: "task-capable", version: "1.0.0" },
      { capabilities: { tasks: { requests: { tools: { call: {} } } } } },
    );
    const coordinator = new AuditCoordinator(sink);
    let executed = false;
    sdk.tool("fictional_tool", "fictional", { value: z.string() }, async (_params, extra) => {
      return coordinator.handleCallback(extra.requestId, async () => {
        executed = true;
        return {
          ok: true,
          callToolResult: { content: [{ type: "text", text: "ok" }] },
          returnedIds: [],
          returnedCount: 0,
        };
      });
    });
    const inner = InMemoryTransport.createLinkedPair();
    const adapter = new AuditedServerTransport({
      inner: inner[1],
      coordinator,
      actor: () => `agent:${sdk.server.getClientVersion()?.name ?? "unknown"}`,
      knownTools: new Set(["fictional_tool"]),
    });
    await sdk.connect(adapter);
    const responses: JSONRPCMessage[] = [];
    inner[0].onmessage = (message) => responses.push(message);
    await inner[0].start();
    await inner[0].send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: { tasks: { requests: { tools: { call: {} } } } },
        clientInfo: { name: "task-capable-client", version: "1" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await inner[0].send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await inner[0].send({
      ...callMessage(2, "fictional_tool", { value: "ok" }),
      params: { name: "fictional_tool", arguments: { value: "ok" }, task: {} },
    } as JSONRPCMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executed).toBe(false);
    expect(sink.events.map((event) => event.phase)).toEqual(["attempt"]);
    const response = responses.find((message) => "id" in message && message.id === 2);
    expect(response).toBeDefined();
    expect(JSON.stringify(response)).toContain("AUDIT_UNAVAILABLE");
    expect(JSON.stringify(response)).not.toContain("Task");
    await adapter.close();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("real task-capable SDK refusal is one audited bare control response", async () => {
    const sink = new RecordingSink();
    const sdk = new SdkMcpServer(
      { name: "task-capable-success", version: "1.0.0" },
      { capabilities: { tasks: { requests: { tools: { call: {} } } } } },
    );
    const coordinator = new AuditCoordinator(sink);
    let sdkInvoked = 0;
    let fictionalInvoked = 0;
    sdk.tool("fictional_tool", "fictional", { value: z.string() }, async (_params, extra) => {
      sdkInvoked += 1;
      return coordinator.handleCallback(extra.requestId, async () => {
        fictionalInvoked += 1;
        return {
          ok: true,
          callToolResult: { content: [{ type: "text", text: "must-not-run" }] },
          returnedIds: ["must-not-release"],
          returnedCount: 1,
        };
      });
    });
    const inner = InMemoryTransport.createLinkedPair();
    const adapter = new AuditedServerTransport({
      inner: inner[1],
      coordinator,
      actor: () => `agent:${sdk.server.getClientVersion()?.name ?? "unknown"}`,
      knownTools: new Set(["fictional_tool"]),
    });
    await sdk.connect(adapter);
    const responses: JSONRPCMessage[] = [];
    inner[0].onmessage = (message) => responses.push(message);
    await inner[0].start();
    await inner[0].send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: { tasks: { requests: { tools: { call: {} } } } },
        clientInfo: { name: "task-capable-success-client", version: "1" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await inner[0].send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await inner[0].send({
      ...callMessage(2, "fictional_tool", { value: "ok" }),
      params: { name: "fictional_tool", arguments: { value: "ok" }, task: {} },
    } as JSONRPCMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sdkInvoked).toBe(1);
    expect(fictionalInvoked).toBe(0);
    expect(sink.events.map((event) => event.phase)).toEqual(["attempt", "result"]);
    expect(sink.events[1]).toMatchObject({
      error: "SDK_REFUSAL",
      ids: [],
      count: 0,
    });
    const response = responses.filter((message) => "id" in message && message.id === 2);
    expect(response).toHaveLength(1);
    expect(response[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32602 },
    });
    expect(response[0]).not.toHaveProperty("result");
    expect(JSON.stringify(response)).not.toContain("AUDIT_UNAVAILABLE");
    await adapter.close();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("audits a malformed known call before SDK refusal and never leaks raw SDK text", async () => {
    const sink = new RecordingSink();
    const server = buildServer({ auditSink: sink });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "raw-client", version: "1.0.0" });
    await client.connect(clientTransport);
    const refused = await client.callTool({ name: "minime_search", arguments: { query: [] } });
    expect(refused.isError).toBe(true);
    expect(sink.events.map((event) => event.phase)).toEqual(["attempt", "result"]);
    expect(sink.events[0]?.tool).toBe("minime_search");
    expect(sink.events[1]?.error).toBe("BAD_INPUT");
    expect(JSON.stringify(sink.events)).not.toContain("query must");
    await client.close();
    await server.close();
  });

  test("malformed task takes BAD_INPUT precedence over malformed name and arguments", async () => {
    const sink = new RecordingSink();
    let executed = false;
    const tool = fictionalTool(async () => {
      executed = true;
      return envelope({ ok: true }, []);
    });
    const server = buildServer({ auditSink: sink, tools: [tool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const responses: JSONRPCMessage[] = [];
    clientTransport.onmessage = (message) => responses.push(message);
    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "malformed-task-precedence", version: "1" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await clientTransport.send({
      jsonrpc: "2.0",
      id: "malformed-task-precedence",
      method: "tools/call",
      params: { name: 7, arguments: [], task: "not-an-object" },
    } as JSONRPCMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(executed).toBe(false);
    expect(sink.events.map((event) => event.phase)).toEqual(["attempt", "result"]);
    expect(sink.events[1]).toMatchObject({ error: "BAD_INPUT" });
    expect(
      responses.filter((message) => "id" in message && message.id === "malformed-task-precedence"),
    ).toHaveLength(1);
    await clientTransport.close();
    await server.close();
  });

  test("conversion failures become one fixed INTERNAL result without leaking values", async () => {
    const sink = new RecordingSink();
    const hostile: ToolDef = {
      name: "hostile_conversion",
      description: "fictional",
      schema: {},
      handler: async () => ({ data: { secret: BigInt(7) }, sources: [] }),
    };
    const server = buildServer({ auditSink: sink, tools: [hostile] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const responses: JSONRPCMessage[] = [];
    const responseEntered = deferred<JSONRPCMessage>();
    clientTransport.onmessage = (message) => {
      responses.push(message);
      if ("id" in message && message.id === 2) responseEntered.resolve(message);
    };
    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "conversion-client", version: "1.0.0" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await clientTransport.send(callMessage(2, "hostile_conversion", {}));
    const response = await within(responseEntered.promise, 500, "conversion response");
    expect(JSON.stringify(response)).not.toContain("7");
    expect(JSON.stringify(response)).toContain("INTERNAL");
    expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(1);
    expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(1);
    expect(sink.events.at(-1)?.error).toBe("INTERNAL");
    await clientTransport.close();
    await server.close();
  });

  test("attempt failure returns fixed response and does not execute the handler", async () => {
    const sink = new RecordingSink();
    sink.failAttempt = true;
    let executed = false;
    const tool = fictionalTool(async () => {
      executed = true;
      return envelope({}, []);
    });
    const { inner, adapter } = setupAdapter(sink, [tool]);
    adapter.onmessage = () => {
      executed = true;
    };
    await adapter.start();
    inner.onmessage?.(callMessage(0, "fictional_tool", { value: "ok" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executed).toBe(false);
    expect(inner.sent).toHaveLength(1);
    expect(JSON.stringify(inner.sent[0]?.message)).toContain("Tool unavailable before execution");
  });

  test("failed attempt keeps a gated fixed response ID duplicate until send settlement", async () => {
    const sink = new RecordingSink();
    sink.failNextAttempt = true;
    const { inner, adapter, coordinator } = setupAdapter(sink, ["fictional_tool"]);
    const fixedSendGate = deferred<void>();
    const fixedSendStarted = deferred<void>();
    const duplicateResultStarted = deferred<void>();
    sink.resultSubmitted = () => duplicateResultStarted.resolve();
    inner.sendGate = fixedSendGate.promise;
    inner.sendStarted = (message) => {
      if ("id" in message && message.id === "attempt-race") fixedSendStarted.resolve();
    };
    let forwarded = 0;
    let mutations = 0;
    await adapter.start();
    adapter.onmessage = (message) => {
      forwarded += 1;
      if ("id" in message && message.id === "attempt-race") {
        void coordinator.handleCallback("attempt-race", async () => {
          mutations += 1;
          return {
            ok: true,
            callToolResult: { content: [{ type: "text", text: "must-not-run" }] },
            returnedIds: ["must-not-release"],
            returnedCount: 1,
          };
        });
      }
    };

    const request = callMessage("attempt-race", "fictional_tool", { value: "ok" });
    inner.onmessage?.(request);
    await within(fixedSendStarted.promise, 500, "fixed attempt response send");
    inner.onmessage?.(request);
    await within(duplicateResultStarted.promise, 500, "duplicate result audit");
    await quietWindow();

    expect(forwarded).toBe(0);
    expect(mutations).toBe(0);
    expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(1);
    expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(1);
    expect(sink.events.at(-1)).toMatchObject({
      phase: "result",
      error: "DUPLICATE_REQUEST_ID",
    });
    expect(inner.closes).toBeGreaterThanOrEqual(1);
    expect(
      inner.sent.filter(({ message }) => "id" in message && message.id === "attempt-race"),
    ).toHaveLength(0);

    fixedSendGate.resolve();
    await within(adapter.drain(), 500, "gated fixed response drain");
    expect(
      inner.sent.filter(({ message }) => "id" in message && message.id === "attempt-race"),
    ).toHaveLength(1);
    expect(coordinator.pendingCount()).toBe(0);
    await adapter.close();
  });

  test("failed direct response send cleans its generation before fail-closed drain", async () => {
    const sink = new RecordingSink();
    sink.failNextAttempt = true;
    const { inner, adapter, coordinator } = setupAdapter(sink, ["fictional_tool"]);
    const sendGate = deferred<void>();
    const sendStarted = deferred<void>();
    const duplicateResultStarted = deferred<void>();
    sink.resultSubmitted = () => duplicateResultStarted.resolve();
    inner.sendGate = sendGate.promise;
    inner.sendStarted = (message) => {
      if ("id" in message && message.id === "direct-failure") sendStarted.resolve();
    };
    const errors: string[] = [];
    let forwarded = 0;
    adapter.onerror = (error) => errors.push(error.message);
    adapter.onmessage = () => {
      forwarded += 1;
    };
    await adapter.start();
    inner.failSend = true;
    const request = callMessage("direct-failure", "fictional_tool", { value: "ok" });
    inner.onmessage?.(request);
    await within(sendStarted.promise, 500, "direct response rejection send");
    inner.onmessage?.(request);
    await within(duplicateResultStarted.promise, 500, "duplicate audit before rejection");
    expect(forwarded).toBe(0);
    expect(sink.events.at(-1)).toMatchObject({ error: "DUPLICATE_REQUEST_ID" });
    sendGate.resolve();
    await within(adapter.drain(), 500, "direct response rejection drain");
    await quietWindow();

    expect(errors).toEqual(["audited MCP transport failure"]);
    expect(forwarded).toBe(0);
    expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(1);
    expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(1);
    expect(inner.closes).toBeGreaterThanOrEqual(1);
    expect(coordinator.pendingCount()).toBe(0);
    await adapter.close();
  });

  test("stale direct completion token cannot remove a reused request generation", async () => {
    const sink = new RecordingSink();
    sink.failNextAttempt = true;
    const coordinator = new AuditCoordinator(sink);
    const first = await coordinator.receiveCall({
      requestId: "generation-reuse",
      actor: "agent:test",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    expect(first.action).toBe("respond");
    if (first.action !== "respond") throw new Error("expected direct attempt response");
    const firstGeneration = (first as { generation: symbol }).generation;
    expect(typeof firstGeneration).toBe("symbol");

    await coordinator.completeDirectResponse("generation-reuse", firstGeneration);
    await Promise.resolve();
    const second = await coordinator.receiveCall({
      requestId: "generation-reuse",
      actor: "agent:test",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    expect(second).toEqual({ action: "forward" });

    await coordinator.completeDirectResponse("generation-reuse", firstGeneration);
    expect(coordinator.pendingCount()).toBe(1);
    await coordinator.handleCallback("generation-reuse", async () => ({
      ok: true,
      callToolResult: { content: [{ type: "text", text: "ok" }] },
      returnedIds: [],
      returnedCount: 0,
    }));
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "generation-reuse",
      result: { content: [] },
    });
    const claim = await coordinator.claimOutbound("generation-reuse", outbound.correlation);
    expect(claim.action).toBe("send");
    if (claim.action !== "send") throw new Error("expected successor send claim");
    await coordinator.completeOutbound("generation-reuse", claim.generation, {
      status: "released",
    });
    await Promise.resolve();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("durable transport send records exactly one released disposition", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink);
    await coordinator.receiveCall({
      requestId: "released",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("released", async () => ({
      ok: true,
      callToolResult: { content: [{ type: "text", text: "ok" }] },
      returnedIds: ["id-1"],
      returnedCount: 1,
    }));
    await adapter.send({ jsonrpc: "2.0", id: "released", result });
    expect(inner.sent).toHaveLength(1);
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions[0]?.disposition).toEqual({ status: "released" });
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("same-generation duplicate send is identity-owned and only the first claim reaches inner.send", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink);
    const sendGate = deferred<void>();
    const sendEntered = deferred<void>();
    inner.sendGate = sendGate.promise;
    inner.sendStarted = () => sendEntered.resolve();
    await coordinator.receiveCall({
      requestId: "single-claim",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("single-claim", async () => ({
      ok: true,
      callToolResult: { content: [{ type: "text", text: "ok" }] },
      returnedIds: ["id-1"],
      returnedCount: 1,
    }));
    const response = { jsonrpc: "2.0", id: "single-claim", result } as const;
    const first = adapter.send(response);
    await within(sendEntered.promise, 500, "first claimed send");
    const second = adapter.send(response);
    try {
      await quietWindow();
      expect(inner.sendCalls).toBe(1);
      expect(sink.dispositionAttempts).toBe(0);
      expect(coordinator.pendingCount()).toBe(1);
    } finally {
      sendGate.resolve();
      await Promise.allSettled([first, second]);
      await adapter.close();
    }
    expect(inner.sent).toHaveLength(1);
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions[0]?.disposition).toEqual({ status: "released" });
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("close waits for a claimed send to fulfill before recording released", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink);
    const sendGate = deferred<void>();
    const sendEntered = deferred<void>();
    inner.sendGate = sendGate.promise;
    inner.sendStarted = () => sendEntered.resolve();
    await coordinator.receiveCall({
      requestId: "close-held-send",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("close-held-send", async () => ({
      ok: true,
      callToolResult: { content: [] },
      returnedIds: [],
      returnedCount: 0,
    }));
    const sending = adapter.send({ jsonrpc: "2.0", id: "close-held-send", result });
    await within(sendEntered.promise, 500, "held close send");
    const closing = adapter.close();
    await quietWindow();
    expect(sink.dispositionAttempts).toBe(0);
    expect(coordinator.pendingCount()).toBe(1);
    sendGate.resolve();
    await sending;
    await within(closing, 500, "close after held send");
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions[0]?.disposition).toEqual({ status: "released" });
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("drain waits for a claimed send rejection before recording send_uncertain", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink);
    const sendGate = deferred<void>();
    const sendEntered = deferred<void>();
    inner.sendGate = sendGate.promise;
    inner.sendStarted = () => sendEntered.resolve();
    inner.failSend = true;
    adapter.onerror = () => {};
    await coordinator.receiveCall({
      requestId: "drain-held-send",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("drain-held-send", async () => ({
      ok: true,
      callToolResult: { content: [] },
      returnedIds: [],
      returnedCount: 0,
    }));
    const sending = adapter.send({ jsonrpc: "2.0", id: "drain-held-send", result });
    await within(sendEntered.promise, 500, "held drain send");
    const draining = adapter.drain();
    await quietWindow();
    expect(sink.dispositionAttempts).toBe(0);
    expect(coordinator.pendingCount()).toBe(1);
    sendGate.resolve();
    await expect(sending).rejects.toThrow("audited MCP transport failure");
    await within(draining, 500, "drain after held send rejection");
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions[0]?.disposition).toEqual({ status: "send_uncertain" });
    expect(coordinator.pendingCount()).toBe(0);
    await adapter.close();
  });

  test("forwarded SDK refusal refreshes durable correlation before local release", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink);
    await coordinator.receiveCall({
      requestId: "durable-refusal",
      actor: "agent:test-client",
      tool: "unknown",
      paramsForAudit: {},
      refusalClass: "unknown",
    });
    await adapter.send({
      jsonrpc: "2.0",
      id: "durable-refusal",
      error: { code: -32601, message: "SDK refusal" },
    });
    expect(inner.sent).toHaveLength(1);
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions[0]?.disposition).toEqual({ status: "released" });
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("durable transport send failure is uncertain, sanitized, and closes once", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink);
    const errors: string[] = [];
    adapter.onerror = (error) => errors.push(error.message);
    await coordinator.receiveCall({
      requestId: "uncertain",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("uncertain", async () => ({
      ok: true,
      callToolResult: { content: [{ type: "text", text: "ok" }] },
      returnedIds: ["secret-id"],
      returnedCount: 1,
    }));
    inner.failSend = true;
    await expect(adapter.send({ jsonrpc: "2.0", id: "uncertain", result })).rejects.toThrow(
      "audited MCP transport failure",
    );
    await within(adapter.drain(), 500, "uncertain disposition drain");
    expect(errors).toEqual(["audited MCP transport failure"]);
    expect(inner.closes).toBe(1);
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions[0]?.disposition).toEqual({ status: "send_uncertain" });
    expect(JSON.stringify(sink.dispositions)).not.toContain("secret-id");
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("truly synchronous inner.send throw is uncertain and sanitized", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink);
    const errors: string[] = [];
    adapter.onerror = (error) => errors.push(error.message);
    await coordinator.receiveCall({
      requestId: "sync-send-failure",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("sync-send-failure", async () => ({
      ok: true,
      callToolResult: { content: [] },
      returnedIds: [],
      returnedCount: 0,
    }));
    inner.syncFailSend = true;
    await expect(adapter.send({ jsonrpc: "2.0", id: "sync-send-failure", result })).rejects.toThrow(
      "audited MCP transport failure",
    );
    await within(adapter.drain(), 500, "sync send failure drain");
    expect(errors).toEqual(["audited MCP transport failure"]);
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions[0]?.disposition).toEqual({ status: "send_uncertain" });
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("send uncertainty plus disposition failure remains one sanitized terminal failure", async () => {
    const sink = new RecordingSink();
    sink.failDisposition = true;
    const { inner, adapter, coordinator } = setupAdapter(sink);
    const errors: string[] = [];
    adapter.onerror = (error) => errors.push(error.message);
    await coordinator.receiveCall({
      requestId: "uncertain-disposition-failure",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("uncertain-disposition-failure", async () => ({
      ok: true,
      callToolResult: { content: [] },
      returnedIds: ["raw-send-secret"],
      returnedCount: 1,
    }));
    inner.failSend = true;
    await expect(
      adapter.send({ jsonrpc: "2.0", id: "uncertain-disposition-failure", result }),
    ).rejects.toThrow("audited MCP transport failure");
    await within(adapter.drain(), 500, "uncertain disposition failure drain");
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions).toHaveLength(0);
    expect(errors).toEqual(["audited MCP transport failure"]);
    expect(inner.closes).toBe(1);
    expect(coordinator.pendingCount()).toBe(0);
    expect(JSON.stringify(errors)).not.toContain("raw-send-secret");
    expect(JSON.stringify(sink.dispositions)).not.toContain("raw disposition secret");
  });

  test("suppressed durable response never enters inner.send", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink);
    await coordinator.receiveCall({
      requestId: "suppressed",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("suppressed", async () => ({
      ok: true,
      callToolResult: { content: [{ type: "text", text: "ok" }] },
      returnedIds: ["secret-id"],
      returnedCount: 1,
    }));
    await coordinator.cancel("suppressed");
    await adapter.send({ jsonrpc: "2.0", id: "suppressed", result });
    expect(inner.sent).toHaveLength(0);
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions[0]?.disposition).toMatchObject({
      status: "suppressed",
      outcome: "completed_not_released",
    });
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("result audit failure uses an owned no-result fixed response without disposition", async () => {
    const sink = new RecordingSink();
    sink.failResult = true;
    const { inner, adapter, coordinator } = setupAdapter(sink);
    await coordinator.receiveCall({
      requestId: "no-result",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("no-result", async () => ({
      ok: true,
      callToolResult: { content: [{ type: "text", text: "secret" }] },
      returnedIds: ["secret-id"],
      returnedCount: 1,
    }));
    expect(JSON.stringify(result)).toContain("completed_result_withheld");
    await adapter.send({ jsonrpc: "2.0", id: "no-result", result });
    expect(inner.sent).toHaveLength(1);
    expect(sink.dispositionAttempts).toBe(0);
    expect(coordinator.pendingCount()).toBe(0);
  });

  // Regression: removing `entry.release === "send"` from drain's claimed-owner wait
  // retires this fixed/no-result generation while its inner send is still held.
  test("no-result send ownership keeps drain and same-ID admission blocked until send settlement", async () => {
    const sink = new RecordingSink();
    sink.failResult = true;
    const { inner, adapter, coordinator } = setupAdapter(sink);
    const sendGate = deferred<void>();
    const sendStarted = deferred<void>();
    inner.sendGate = sendGate.promise;
    inner.sendStarted = (message) => {
      if ("id" in message && message.id === "no-result-drain-race") sendStarted.resolve();
    };

    const request = {
      requestId: "no-result-drain-race",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known" as const,
    };
    await coordinator.receiveCall(request);
    const result = await coordinator.handleCallback(request.requestId, async () => ({
      ok: true,
      callToolResult: { content: [{ type: "text", text: "secret" }] },
      returnedIds: ["secret-id"],
      returnedCount: 1,
    }));
    expect(JSON.stringify(result)).toContain("completed_result_withheld");

    const sending = adapter.send({ jsonrpc: "2.0", id: request.requestId, result });
    await within(sendStarted.promise, 500, "held no-result send");
    const adapterDraining = adapter.drain();
    const coordinatorDraining = coordinator.drain();
    let coordinatorDrainSettled = false;
    void coordinatorDraining.then(() => {
      coordinatorDrainSettled = true;
    });
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
    expect(coordinatorDrainSettled).toBe(false);
    expect(coordinator.pendingCount()).toBe(1);

    const successor = await coordinator.receiveCall(request);
    expect(successor).toEqual({ action: "drop", closeTransport: true });
    expect(coordinator.pendingCount()).toBe(1);
    expect(sink.dispositionAttempts).toBe(0);

    sendGate.resolve();
    await sending;
    await within(adapterDraining, 500, "adapter drain after no-result send");
    await within(coordinatorDraining, 500, "coordinator drain after no-result send");
    expect(coordinator.pendingCount()).toBe(0);
    expect(sink.dispositionAttempts).toBe(0);

    sink.failResult = false;
    const reused = await coordinator.receiveCall(request);
    expect(reused).toEqual({ action: "forward" });
    let executed = false;
    const reusedResult = await coordinator.handleCallback(request.requestId, async () => {
      executed = true;
      return {
        ok: true,
        callToolResult: { content: [] },
        returnedIds: [],
        returnedCount: 0,
      };
    });
    expect(executed).toBe(true);
    const reusedOutbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: request.requestId,
      result: reusedResult,
    });
    await adapter.send(reusedOutbound.message);
    expect(coordinator.pendingCount()).toBe(0);
    expect(sink.dispositionAttempts).toBe(1);
    await adapter.close();
  });

  test("no-result cancel then close and close then cancel both drop without disposition", async () => {
    const run = async (requestId: string, first: "cancel" | "close") => {
      const sink = new RecordingSink();
      sink.failResult = true;
      const { inner, adapter, coordinator } = setupAdapter(sink);
      await coordinator.receiveCall({
        requestId,
        actor: "agent:test-client",
        tool: "fictional_tool",
        paramsForAudit: {},
        refusalClass: "known",
      });
      const result = await coordinator.handleCallback(requestId, async () => ({
        ok: true,
        callToolResult: { content: [] },
        returnedIds: ["secret-id"],
        returnedCount: 1,
      }));
      if (first === "cancel") {
        await coordinator.cancel(requestId);
        await coordinator.transportClosed();
      } else {
        await coordinator.transportClosed();
        await coordinator.cancel(requestId);
      }
      await adapter.send({ jsonrpc: "2.0", id: requestId, result });
      expect(inner.sent).toHaveLength(0);
      expect(sink.dispositionAttempts).toBe(0);
      expect(coordinator.pendingCount()).toBe(0);
    };
    await run("no-result-cancel-close", "cancel");
    await run("no-result-close-cancel", "close");
  });

  test("gated no-result claim keeps the first terminal signal and never enters inner.send", async () => {
    const run = async (requestId: string, first: "cancel" | "close") => {
      const sink = new RecordingSink();
      sink.failResult = true;
      const claimGate = deferred<void>();
      const inner = new RecordingTransport();
      const coordinator = new AuditCoordinator(sink, {
        beforeOutboundClaim: async () => claimGate.promise,
      });
      const adapter = new AuditedServerTransport({
        inner,
        coordinator,
        actor: () => "agent:test-client",
        knownTools: new Set(["fictional_tool"]),
      });
      await coordinator.receiveCall({
        requestId,
        actor: "agent:test-client",
        tool: "fictional_tool",
        paramsForAudit: {},
        refusalClass: "known",
      });
      const result = await coordinator.handleCallback(requestId, async () => ({
        ok: true,
        callToolResult: { content: [] },
        returnedIds: [],
        returnedCount: 0,
      }));
      if (first === "cancel") {
        await coordinator.cancel(requestId);
        await coordinator.transportClosed();
      } else {
        await coordinator.transportClosed();
        await coordinator.cancel(requestId);
      }
      const sending = adapter.send({ jsonrpc: "2.0", id: requestId, result });
      await Promise.resolve();
      expect(inner.sent).toHaveLength(0);
      claimGate.resolve();
      await sending;
      expect(inner.sent).toHaveLength(0);
      expect(sink.dispositionAttempts).toBe(0);
      expect(coordinator.pendingCount()).toBe(0);
    };
    await run("gated-no-result-cancel-close", "cancel");
    await run("gated-no-result-close-cancel", "close");
  });

  test("valid no-result claim raced with cancel before cleanup drops without send or disposition", async () => {
    const run = async (requestId: string, signal: "cancel" | "close") => {
      const sink = new RecordingSink();
      sink.failResult = true;
      const claimGate = deferred<void>();
      const claimEntered = deferred<void>();
      const inner = new RecordingTransport();
      const coordinator = new AuditCoordinator(sink, {
        beforeOutboundClaim: async () => {
          claimEntered.resolve();
          await claimGate.promise;
        },
      });
      const adapter = new AuditedServerTransport({
        inner,
        coordinator,
        actor: () => "agent:test-client",
        knownTools: new Set(["fictional_tool"]),
      });
      await coordinator.receiveCall({
        requestId,
        actor: "agent:test-client",
        tool: "fictional_tool",
        paramsForAudit: {},
        refusalClass: "known",
      });
      const result = await coordinator.handleCallback(requestId, async () => ({
        ok: true,
        callToolResult: { content: [] },
        returnedIds: [],
        returnedCount: 0,
      }));

      const sending = adapter.send({
        jsonrpc: "2.0",
        id: requestId,
        result,
      });
      await claimEntered.promise;
      const terminal =
        signal === "cancel" ? coordinator.cancel(requestId) : coordinator.transportClosed();
      claimGate.resolve();

      await sending;
      expect(inner.sent).toHaveLength(0);
      expect(sink.dispositionAttempts).toBe(0);
      await terminal;
      expect(coordinator.pendingCount()).toBe(0);
    };
    await run("claim-race-before-cleanup-cancel", "cancel");
    await run("claim-race-before-cleanup-close", "close");
  });

  test("claim-gated no-result send races cancel/close in both terminal orders", async () => {
    const run = async (requestId: string, first: "cancel" | "close") => {
      const sink = new RecordingSink();
      sink.failResult = true;
      const claimGate = deferred<void>();
      const claimEntered = deferred<void>();
      const inner = new RecordingTransport();
      const coordinator = new AuditCoordinator(sink, {
        beforeOutboundClaim: async () => {
          claimEntered.resolve();
          await claimGate.promise;
        },
      });
      const adapter = new AuditedServerTransport({
        inner,
        coordinator,
        actor: () => "agent:test-client",
        knownTools: new Set(["fictional_tool"]),
      });
      await coordinator.receiveCall({
        requestId,
        actor: "agent:test-client",
        tool: "fictional_tool",
        paramsForAudit: {},
        refusalClass: "known",
      });
      const result = await coordinator.handleCallback(requestId, async () => ({
        ok: true,
        callToolResult: { content: [] },
        returnedIds: [],
        returnedCount: 0,
      }));
      const sending = adapter.send({ jsonrpc: "2.0", id: requestId, result });
      await claimEntered.promise;
      const terminalA =
        first === "cancel" ? coordinator.cancel(requestId) : coordinator.transportClosed();
      const terminalB =
        first === "cancel" ? coordinator.transportClosed() : coordinator.cancel(requestId);
      await Promise.all([terminalA, terminalB]);
      expect(inner.sent).toHaveLength(0);
      claimGate.resolve();
      await sending;
      expect(inner.sent).toHaveLength(0);
      expect(sink.dispositionAttempts).toBe(0);
      expect(coordinator.pendingCount()).toBe(0);

      sink.failResult = false;
      await coordinator.receiveCall({
        requestId,
        actor: "agent:test-client",
        tool: "fictional_tool",
        paramsForAudit: {},
        refusalClass: "known",
      });
      const successor = await coordinator.handleCallback(requestId, async () => ({
        ok: true,
        callToolResult: { content: [] },
        returnedIds: [],
        returnedCount: 0,
      }));
      await adapter.send({ jsonrpc: "2.0", id: requestId, result: successor });
      expect(inner.sent).toHaveLength(1);
      expect(sink.dispositionAttempts).toBe(1);
      await adapter.close();
    };
    await run("claim-race-cancel-close", "cancel");
    await run("claim-race-close-cancel", "close");
  });

  test("no-result claim after release is sendable and stale completion cannot retire successor", async () => {
    const sink = new RecordingSink();
    sink.failResult = true;
    const { inner, adapter, coordinator } = setupAdapter(sink);
    await coordinator.receiveCall({
      requestId: "no-result-generation",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const firstResult = await coordinator.handleCallback("no-result-generation", async () => ({
      ok: true,
      callToolResult: { content: [] },
      returnedIds: [],
      returnedCount: 0,
    }));
    const firstOutbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "no-result-generation",
      result: firstResult,
    });
    if (
      firstOutbound.action !== "send" ||
      firstOutbound.correlation.kind === "untracked" ||
      firstOutbound.correlation.result !== "no_result"
    )
      throw new Error("expected no-result correlation");
    expect(firstOutbound.correlation.result).toBe("no_result");
    const firstClaim = await coordinator.claimNoResultOutbound(
      "no-result-generation",
      firstOutbound.correlation,
    );
    expect(firstClaim.action).toBe("send");
    if (firstClaim.action !== "send") throw new Error("expected no-result send claim");
    await coordinator.completeNoResultOutbound("no-result-generation", firstClaim.generation);
    await Promise.resolve();

    sink.failResult = false;
    await coordinator.receiveCall({
      requestId: "no-result-generation",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    await coordinator.handleCallback("no-result-generation", async () => ({
      ok: true,
      callToolResult: { content: [] },
      returnedIds: [],
      returnedCount: 0,
    }));
    await coordinator.completeNoResultOutbound("no-result-generation", firstClaim.generation);
    expect(coordinator.pendingCount()).toBe(1);
    const secondResult = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "no-result-generation",
      result: { content: [] },
    });
    if (secondResult.action !== "send" || !secondResult.correlation)
      throw new Error("expected successor correlation");
    await adapter.send(secondResult.message);
    expect(inner.sent).toHaveLength(1);
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("truly unrelated response IDs are untracked and pass through", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink);
    const message = { jsonrpc: "2.0", id: "unrelated", result: { content: [] } } as const;
    const decision = await coordinator.handleOutbound(message);
    expect(decision.correlation).toEqual({ kind: "untracked" });
    if (!decision.correlation) throw new Error("expected explicit untracked correlation");
    expect((await coordinator.claimOutbound("unrelated", decision.correlation)).action).toBe(
      "untracked",
    );
    await adapter.send(message);
    expect(inner.sent).toHaveLength(1);
    expect(sink.dispositionAttempts).toBe(0);
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("no-result claim rejects a durable correlation instead of acquiring send ownership", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall({
      requestId: "durable-not-no-result",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("durable-not-no-result", async () => ({
      ok: true,
      callToolResult: { content: [] },
      returnedIds: [],
      returnedCount: 0,
    }));
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "durable-not-no-result",
      result,
    });
    if (outbound.correlation.kind === "untracked") throw new Error("expected durable correlation");
    expect(outbound.correlation.result).toBe("durable");
    expect(
      // @ts-expect-error durable correlations are forbidden by the no-result claim API
      (await coordinator.claimNoResultOutbound("durable-not-no-result", outbound.correlation))
        .action,
    ).toBe("drop");
    expect(coordinator.pendingCount()).toBe(1);
    await coordinator.drain();
  });

  test("no-result completion hook retires once and sanitizes its raw failure", async () => {
    const sink = new RecordingSink();
    sink.failResult = true;
    const inner = new RecordingTransport();
    let completionCalls = 0;
    const coordinator = new AuditCoordinator(sink, {
      beforeNoResultCompletion: async () => {
        completionCalls += 1;
        throw new Error("raw completion secret");
      },
    });
    const adapter = new AuditedServerTransport({
      inner,
      coordinator,
      actor: () => "agent:test-client",
      knownTools: new Set(["fictional_tool"]),
    });
    const errors: string[] = [];
    adapter.onerror = (error) => errors.push(error.message);
    await coordinator.receiveCall({
      requestId: "completion-failure",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("completion-failure", async () => ({
      ok: false,
      callToolResult: { isError: true, content: [] },
      returnedIds: [],
      returnedCount: 0,
      error: "INTERNAL",
    }));
    await expect(
      adapter.send({ jsonrpc: "2.0", id: "completion-failure", result }),
    ).rejects.toThrow("audited MCP transport failure");
    await within(adapter.drain(), 500, "completion failure drain");
    expect(completionCalls).toBe(1);
    expect(errors).toEqual(["audited MCP transport failure"]);
    expect(JSON.stringify(errors)).not.toContain("raw completion secret");
    expect(sink.dispositionAttempts).toBe(0);
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("identity tombstone drops a late response before cleanup and leaves no disposition retry", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink);
    await coordinator.receiveCall({
      requestId: "late",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("late", async () => ({
      ok: true,
      callToolResult: { content: [{ type: "text", text: "ok" }] },
      returnedIds: [],
      returnedCount: 0,
    }));
    const first = await coordinator.handleOutbound({ jsonrpc: "2.0", id: "late", result });
    expect(first.action).toBe("send");
    if (first.action !== "send" || !first.correlation)
      throw new Error("expected captured correlation");
    const claim = await coordinator.claimOutbound("late", first.correlation);
    expect(claim.action).toBe("send");
    if (claim.action !== "send") throw new Error("expected send claim");
    const completion = coordinator.completeOutbound("late", claim.generation, {
      status: "released",
    });
    const latePromise = coordinator.handleOutbound({ jsonrpc: "2.0", id: "late", result });
    await completion;
    const late = await latePromise;
    expect(late.action).toBe("send");
    if (late.action !== "send" || !late.correlation)
      throw new Error("expected tombstone correlation");
    expect(["pending", "tombstone"]).toContain(late.correlation.kind);
    const dropped = await coordinator.claimOutbound("late", late.correlation);
    expect(dropped.action).toBe("drop");
    expect(inner.sent).toHaveLength(0);
    expect(sink.dispositionAttempts).toBe(1);
    await adapter.close();
  });

  test("suppressed disposition failure is sanitized, not retried, and drains", async () => {
    const sink = new RecordingSink();
    sink.failDisposition = true;
    const { inner, adapter, coordinator } = setupAdapter(sink);
    const errors: string[] = [];
    adapter.onerror = (error) => errors.push(error.message);
    await coordinator.receiveCall({
      requestId: "suppressed-disposition-failure",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("suppressed-disposition-failure", async () => ({
      ok: true,
      callToolResult: { content: [] },
      returnedIds: ["secret-id"],
      returnedCount: 1,
    }));
    await expect(coordinator.cancel("suppressed-disposition-failure")).rejects.toThrow(
      "raw disposition secret",
    );
    await expect(
      adapter.send({ jsonrpc: "2.0", id: "suppressed-disposition-failure", result }),
    ).rejects.toThrow("audited MCP transport failure");
    await within(adapter.drain(), 500, "suppressed disposition failure drain");
    expect(sink.dispositionAttempts).toBe(1);
    expect(errors).toEqual(["audited MCP transport failure"]);
    expect(inner.closes).toBe(1);
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("pre-forward suppressed disposition failure reports one sanitized error and closes", async () => {
    const sink = new RecordingSink();
    const attemptGate = deferred<void>();
    const attemptEntered = deferred<void>();
    const resultSubmitted = deferred<void>();
    sink.attemptGate = attemptGate.promise;
    sink.attemptStarted = () => attemptEntered.resolve();
    sink.resultSubmitted = () => resultSubmitted.resolve();
    sink.failDisposition = true;
    const { inner, adapter, coordinator } = setupAdapter(sink, ["fictional_tool"]);
    const errors: string[] = [];
    adapter.onerror = (error) => errors.push(error.message);
    await adapter.start();
    inner.onmessage?.(callMessage("pre-forward-disposition", "fictional_tool", { value: "ok" }));
    await within(attemptEntered.promise, 500, "pre-forward attempt");
    inner.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "pre-forward-disposition" },
    });
    attemptGate.resolve();
    try {
      await within(resultSubmitted.promise, 500, "pre-forward terminal result");
      await quietWindow();
      expect(errors).toEqual(["audited MCP transport failure"]);
      expect(inner.closes).toBe(1);
      expect(sink.dispositionAttempts).toBe(1);
      expect(sink.dispositions).toHaveLength(0);
      expect(coordinator.pendingCount()).toBe(0);
      expect(JSON.stringify(errors)).not.toContain("raw disposition secret");
    } finally {
      await adapter.close();
    }
  });

  test("synchronous disposition throw is one attempted failure and sanitized", async () => {
    const sink = new RecordingSink();
    sink.syncFailDisposition = true;
    const { inner, adapter, coordinator } = setupAdapter(sink);
    const errors: string[] = [];
    adapter.onerror = (error) => errors.push(error.message);
    await coordinator.receiveCall({
      requestId: "sync-disposition-failure",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("sync-disposition-failure", async () => ({
      ok: true,
      callToolResult: { content: [] },
      returnedIds: [],
      returnedCount: 0,
    }));
    await expect(coordinator.cancel("sync-disposition-failure")).rejects.toThrow(
      "raw synchronous disposition secret",
    );
    await expect(
      adapter.send({ jsonrpc: "2.0", id: "sync-disposition-failure", result }),
    ).rejects.toThrow("audited MCP transport failure");
    await within(adapter.drain(), 500, "sync disposition failure drain");
    expect(sink.dispositionAttempts).toBe(1);
    expect(errors).toEqual(["audited MCP transport failure"]);
    expect(inner.closes).toBe(1);
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("released disposition failure does not replace the already fulfilled wire send", async () => {
    const sink = new RecordingSink();
    sink.failDisposition = true;
    const { inner, adapter, coordinator } = setupAdapter(sink);
    const errors: string[] = [];
    adapter.onerror = (error) => errors.push(error.message);
    await coordinator.receiveCall({
      requestId: "released-disposition-failure",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("released-disposition-failure", async () => ({
      ok: true,
      callToolResult: { content: [] },
      returnedIds: [],
      returnedCount: 0,
    }));
    await expect(
      adapter.send({ jsonrpc: "2.0", id: "released-disposition-failure", result }),
    ).rejects.toThrow("audited MCP transport failure");
    expect(inner.sent).toHaveLength(1);
    await within(adapter.drain(), 500, "released disposition failure drain");
    expect(sink.dispositionAttempts).toBe(1);
    expect(errors).toEqual(["audited MCP transport failure"]);
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("a held disposition keeps adapter drain pending until the gate opens", async () => {
    const sink = new RecordingSink();
    const gate = deferred<void>();
    sink.dispositionGate = gate.promise;
    const { adapter, coordinator } = setupAdapter(sink);
    await coordinator.receiveCall({
      requestId: "held-disposition",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("held-disposition", async () => ({
      ok: true,
      callToolResult: { content: [] },
      returnedIds: [],
      returnedCount: 0,
    }));
    const cancel = coordinator.cancel("held-disposition");
    await Promise.resolve();
    const draining = adapter.drain();
    const status = await Promise.race([
      draining.then(() => "done" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(status).toBe("pending");
    gate.resolve();
    await cancel;
    await within(draining, 500, "held disposition drain");
    expect(sink.dispositionAttempts).toBe(1);
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("cancel before a no-result claim drops the fixed replacement without disposition", async () => {
    const sink = new RecordingSink();
    sink.failResult = true;
    const { inner, adapter, coordinator } = setupAdapter(sink);
    await coordinator.receiveCall({
      requestId: "no-result-cancel",
      actor: "agent:test-client",
      tool: "fictional_tool",
      paramsForAudit: {},
      refusalClass: "known",
    });
    const result = await coordinator.handleCallback("no-result-cancel", async () => ({
      ok: true,
      callToolResult: { content: [] },
      returnedIds: ["secret-id"],
      returnedCount: 1,
    }));
    await coordinator.cancel("no-result-cancel");
    await adapter.send({ jsonrpc: "2.0", id: "no-result-cancel", result });
    expect(inner.sent).toHaveLength(0);
    expect(sink.dispositionAttempts).toBe(0);
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("inner send rejection is sanitized and fail-closed", async () => {
    const { inner, adapter } = setupAdapter();
    const errors: string[] = [];
    adapter.onerror = (error) => errors.push(error.message);
    await adapter.start();
    inner.failSend = true;
    await expect(adapter.send({ jsonrpc: "2.0", id: "outbound", result: {} })).rejects.toThrow(
      "audited MCP transport failure",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual(["audited MCP transport failure"]);
    expect(inner.closes).toBeGreaterThanOrEqual(1);
    await adapter.close();
  });

  test("admitted-call coordinator rejection reports once, leaks no raw error, and closes", async () => {
    const sink = new RecordingSink();
    const inner = new RecordingTransport();
    const coordinator = new AuditCoordinator(sink, {
      afterForwardDecision: async () => {
        throw new Error("coordinator secret");
      },
    });
    const adapter = new AuditedServerTransport({
      inner,
      coordinator,
      actor: () => "agent:test-client",
      knownTools: new Set(["fictional_tool"]),
    });
    const errors: string[] = [];
    adapter.onerror = (error) => errors.push(error.message);
    await adapter.start();
    inner.onmessage?.(callMessage("coordinator", "fictional_tool", { value: "ok" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual(["audited MCP transport failure"]);
    expect(inner.closes).toBeGreaterThanOrEqual(1);
    expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain("coordinator secret");
    await adapter.close();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("admitted-call direct send rejection is sanitized and drains the terminal audit", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink, ["fictional_tool"]);
    adapter.onerror = () => {};
    await adapter.start();
    adapter.onmessage = () => {};
    inner.onmessage?.(callMessage("direct-send", "fictional_tool", { value: "ok" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    inner.failSend = true;
    await expect(
      adapter.send({ jsonrpc: "2.0", id: "direct-send", result: { content: [] } }),
    ).rejects.toThrow("audited MCP transport failure");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(1);
    expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(1);
    expect(coordinator.pendingCount()).toBe(0);
    await adapter.close();
  });

  test("duplicate request IDs are fail-closed with one original execution", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink);
    await adapter.start();
    let forwarded = 0;
    adapter.onmessage = () => {
      forwarded += 1;
    };
    const request = callMessage("same", "fictional_tool", {});
    inner.onmessage?.(request);
    await Promise.resolve();
    inner.onmessage?.(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded).toBe(1);
    expect(inner.closes).toBeGreaterThanOrEqual(1);
    expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(2);
    expect(
      sink.events
        .filter((event) => event.phase === "result")
        .some((event) => event.error === "DUPLICATE_REQUEST_ID"),
    ).toBe(true);
    await adapter.close();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("duplicate running IDs close without a second response and request IDs can be reused after cleanup", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink, ["fictional_tool"]);
    await adapter.start();
    let forwarded = 0;
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    adapter.onmessage = (message) => {
      forwarded += 1;
      if ("id" in message && message.id === "running") {
        void coordinator.handleCallback("running", async () => {
          started();
          await barrier;
          return {
            ok: true,
            callToolResult: { content: [{ type: "text", text: "ok" }] },
            returnedIds: ["secret"],
            returnedCount: 1,
          };
        });
      }
    };
    const running = callMessage("running", "fictional_tool", { value: "ok" });
    inner.onmessage?.(running);
    await startedPromise;
    inner.onmessage?.(running);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded).toBe(1);
    expect(
      sink.events
        .filter((event) => event.phase === "result")
        .some((event) => event.error === "DUPLICATE_REQUEST_ID"),
    ).toBe(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      inner.sent.filter(({ message }) => "id" in message && message.id === "running"),
    ).toHaveLength(0);
    await adapter.close();
    expect(coordinator.pendingCount()).toBe(0);

    const reuseSink = new RecordingSink();
    const reuse = setupAdapter(reuseSink, ["fictional_tool"]);
    await reuse.adapter.start();
    let reuseForwarded = 0;
    reuse.adapter.onmessage = () => {
      reuseForwarded += 1;
    };
    reuse.inner.onmessage?.(callMessage("reuse", "fictional_tool", { value: "ok" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reuse.adapter.send({ jsonrpc: "2.0", id: "reuse", result: { content: [] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reuse.coordinator.pendingCount()).toBe(0);
    reuse.inner.onmessage?.(callMessage("reuse", "fictional_tool", { value: "ok" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reuseForwarded).toBe(2);
    await reuse.adapter.close();
  });

  test("facade cancels numeric ID 0 while attempt audit is paused", async () => {
    const sink = new RecordingSink();
    const attemptGate = deferred<void>();
    const attemptStarted = deferred<void>();
    const resultSubmitted = deferred<void>();
    sink.attemptGate = attemptGate.promise;
    sink.attemptStarted = () => attemptStarted.resolve();
    sink.resultSubmitted = () => resultSubmitted.resolve();
    let mutations = 0;
    const tool = fictionalTool(async () => {
      mutations += 1;
      return envelope({ ok: true }, []);
    });
    const server = buildServer({ auditSink: sink, tools: [tool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const responses: JSONRPCMessage[] = [];
    await server.connect(serverTransport);
    await initializeRawTransport(clientTransport, responses, "attempt-paused-client");
    try {
      await clientTransport.send(callMessage(0, "fictional_tool", { value: "ok" }));
      await within(attemptStarted.promise, 500, "attempt entry");
      const cancellation = clientTransport.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 0 },
      });
      await Promise.resolve();
      attemptGate.resolve();
      await within(cancellation, 500, "attempt cancellation dispatch");
      await within(resultSubmitted.promise, 500, "cancelled result audit");
      await quietWindow();

      expect(mutations).toBe(0);
      expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(1);
      expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(1);
      expect(sink.events[0]).toMatchObject({
        phase: "attempt",
        tool: "fictional_tool",
        params: { value: "ok" },
      });
      expect(sink.events[1]).toMatchObject({
        phase: "result",
        ids: [],
        count: 0,
        error: undefined,
        paramsHash: paramsHash({ value: "ok" }),
      });
      expect(sink.dispositions.at(-1)).toMatchObject({
        disposition: { status: "suppressed", outcome: "cancelled_before_execution" },
      });
      expect(responses.filter((message) => "id" in message && message.id === 0)).toHaveLength(0);
      await within(server.close(), 500, "attempt-paused close");
    } finally {
      attemptGate.resolve();
      await server.close().catch(() => {});
    }
  });

  test("facade cancellation at forward and callback barriers prevents handler start", async () => {
    const sink = new RecordingSink();
    const afterForwardEntered = deferred<void>();
    const afterForwardGate = deferred<void>();
    const beforeCallbackEntered = deferred<void>();
    const beforeCallbackGate = deferred<void>();
    const resultSubmitted = deferred<void>();
    sink.resultSubmitted = () => resultSubmitted.resolve();
    let mutations = 0;
    const tool = fictionalTool(async () => {
      mutations += 1;
      return envelope({ ok: true }, []);
    });
    const server = buildServer({
      auditSink: sink,
      tools: [tool],
      hooks: {
        afterForwardDecision: async () => {
          afterForwardEntered.resolve();
          await afterForwardGate.promise;
        },
        beforeCallbackStart: async () => {
          beforeCallbackEntered.resolve();
          await beforeCallbackGate.promise;
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const responses: JSONRPCMessage[] = [];
    await server.connect(serverTransport);
    await initializeRawTransport(clientTransport, responses, "barrier-client");
    try {
      await clientTransport.send(callMessage("barrier", "fictional_tool", { value: "ok" }));
      await within(afterForwardEntered.promise, 500, "after-forward barrier entry");
      afterForwardGate.resolve();
      await within(beforeCallbackEntered.promise, 500, "before-callback barrier entry");
      const cancellation = clientTransport.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "barrier" },
      });
      await Promise.resolve();
      beforeCallbackGate.resolve();
      await within(cancellation, 500, "barrier cancellation dispatch");
      await within(resultSubmitted.promise, 500, "barrier cancelled result");
      await quietWindow();

      expect(mutations).toBe(0);
      expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(1);
      expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(1);
      expect(sink.events[1]).toMatchObject({
        phase: "result",
        ids: [],
        count: 0,
      });
      expect(sink.dispositions.at(-1)).toMatchObject({
        disposition: { status: "suppressed", outcome: "cancelled_before_execution" },
      });
      expect(
        responses.filter((message) => "id" in message && message.id === "barrier"),
      ).toHaveLength(0);
      await within(server.close(), 500, "barrier cancellation close");
    } finally {
      afterForwardGate.resolve();
      beforeCallbackGate.resolve();
      await server.close().catch(() => {});
    }
  });

  test("facade pre-submission cancellation after handler mutation authorizes zero IDs", async () => {
    const sink = new RecordingSink();
    const handlerStarted = deferred<void>();
    const handlerGate = deferred<void>();
    const resultSubmitted = deferred<void>();
    sink.resultSubmitted = () => resultSubmitted.resolve();
    let mutations = 0;
    const tool = fictionalTool(async () => {
      mutations += 1;
      handlerStarted.resolve();
      await handlerGate.promise;
      return envelope({ ok: true }, [{ type: "test", id: "secret" }]);
    });
    const server = buildServer({ auditSink: sink, tools: [tool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const responses: JSONRPCMessage[] = [];
    await server.connect(serverTransport);
    await initializeRawTransport(clientTransport, responses, "running-cancel-client");
    try {
      await clientTransport.send(callMessage(0, "fictional_tool", { value: "ok" }));
      await within(handlerStarted.promise, 500, "handler start");
      const cancellation = clientTransport.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 0 },
      });
      await Promise.resolve();
      handlerGate.resolve();
      await within(cancellation, 500, "running cancellation dispatch");
      await within(resultSubmitted.promise, 500, "running cancellation result");
      await quietWindow();

      expect(mutations).toBe(1);
      expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(1);
      const result = sink.events.find((event) => event.phase === "result");
      expect(result).toMatchObject({ ids: [], count: 0 });
      expect(sink.dispositions.at(-1)).toMatchObject({
        disposition: { status: "suppressed", outcome: "completed_not_released" },
      });
      expect(responses.filter((message) => "id" in message && message.id === 0)).toHaveLength(0);
      await within(server.close(), 500, "running cancellation close");
    } finally {
      handlerGate.resolve();
      await server.close().catch(() => {});
    }
  });

  test("late cancellation after durable result conservatively over-reports IDs but suppresses wire release", async () => {
    const sink = new RecordingSink();
    const { inner, adapter, coordinator } = setupAdapter(sink, ["fictional_tool"]);
    const callbackFinished = deferred<void>();
    await adapter.start();
    adapter.onmessage = (message) => {
      if ("id" in message && message.id === "late") {
        void coordinator
          .handleCallback("late", async () => ({
            ok: true,
            callToolResult: {
              content: [{ type: "text", text: "ZQX-LATE-RESPONSE" }],
            },
            returnedIds: ["ZQX-LATE-ID"],
            returnedCount: 1,
          }))
          .then(() => callbackFinished.resolve());
      }
    };
    inner.onmessage?.(callMessage("late", "fictional_tool", { value: "ok" }));
    await within(callbackFinished.promise, 500, "late callback completion");
    expect(sink.events.at(-1)).toMatchObject({
      phase: "result",
      ids: ["ZQX-LATE-ID"],
      count: 1,
    });

    await expect(coordinator.cancel("late")).resolves.toEqual({
      forwardNotification: false,
      closeTransport: false,
    });
    await adapter.send({
      jsonrpc: "2.0",
      id: "late",
      result: { content: [{ type: "text", text: "ZQX-LATE-RESPONSE" }] },
    });
    expect(
      inner.sent.filter(({ message }) => "id" in message && message.id === "late"),
    ).toHaveLength(0);
    expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(1);
    await adapter.close();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("facade close waits for active completion durability before reconnect", async () => {
    const sink = new RecordingSink();
    const firstHandlerStarted = deferred<void>();
    const firstHandlerGate = deferred<void>();
    const firstResultStarted = deferred<void>();
    const firstResultGate = deferred<void>();
    sink.resultDurableGate = firstResultGate.promise;
    sink.resultSubmitted = (actor, tool) => {
      if (
        tool === "fictional_tool" &&
        sink.events.filter((event) => event.phase === "result").length === 0
      ) {
        firstResultStarted.resolve();
      }
      void actor;
    };
    let mutations = 0;
    const tool = fictionalTool(async () => {
      mutations += 1;
      if (mutations === 1) {
        firstHandlerStarted.resolve();
        await firstHandlerGate.promise;
      }
      return envelope({ mutation: mutations }, [{ type: "test", id: "secret" }]);
    });
    const server = buildServer({ auditSink: sink, tools: [tool] });
    const [firstClient, firstServerTransport] = InMemoryTransport.createLinkedPair();
    const firstResponses: JSONRPCMessage[] = [];
    firstClient.onmessage = (message) => firstResponses.push(message);
    await server.connect(firstServerTransport);
    await initializeRawTransport(firstClient, firstResponses, "active-close-first");
    let closePromise: Promise<void> | undefined;
    try {
      await firstClient.send(callMessage("first", "fictional_tool", { value: "ok" }));
      await within(firstHandlerStarted.promise, 500, "first handler mutation");

      closePromise = server.close();
      const [secondRejectedClient, secondRejectedServer] = InMemoryTransport.createLinkedPair();
      await expect(server.connect(secondRejectedServer)).rejects.toThrow(/connected or closing/);
      await secondRejectedClient.close();
      await quietWindow(25);
      firstHandlerGate.resolve();
      await within(firstResultStarted.promise, 500, "disconnect result audit entry");
      const closeBeforeResultRelease = await Promise.race([
        closePromise.then(() => "closed" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]);
      expect(closeBeforeResultRelease).toBe("pending");
      firstResultGate.resolve();
      await within(closePromise, 500, "active close durability");

      expect(mutations).toBe(1);
      expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(1);
      expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(1);
      expect(sink.events[1]).toMatchObject({ phase: "result", ids: [], count: 0 });
      expect(sink.dispositions.at(-1)).toMatchObject({
        disposition: { status: "suppressed", outcome: "completed_after_disconnect" },
      });
      expect(
        firstResponses.filter((message) => "id" in message && message.id === "first"),
      ).toHaveLength(0);

      const [secondClient, secondServerTransport] = InMemoryTransport.createLinkedPair();
      const secondResponses: JSONRPCMessage[] = [];
      const secondResultStarted = deferred<void>();
      sink.resultSubmitted = () => secondResultStarted.resolve();
      await server.connect(secondServerTransport);
      await initializeRawTransport(secondClient, secondResponses, "active-close-second");
      await secondClient.send(callMessage("second", "fictional_tool", { value: "ok" }));
      await within(secondResultStarted.promise, 500, "second result audit");
      await quietWindow();

      expect(mutations).toBe(2);
      expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(2);
      expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(2);
      expect(sink.events[3]).toMatchObject({
        phase: "result",
        ids: ["secret"],
        count: 1,
      });
      expect(
        secondResponses.filter((message) => "id" in message && message.id === "second"),
      ).toHaveLength(1);
      expect(
        firstResponses.filter((message) => "id" in message && message.id === "first"),
      ).toHaveLength(0);
      await within(secondClient.close(), 500, "second client close");
      await within(server.close(), 500, "second server close");
    } finally {
      firstHandlerGate.resolve();
      firstResultGate.resolve();
      await server.close().catch(() => {});
      if (closePromise) await closePromise.catch(() => {});
    }
  });

  test("stdio does not release normal or refusal responses before result audit", async () => {
    const sink = new RecordingSink();
    const normalResultSubmitted = deferred<void>();
    const normalResultDurability = deferred<void>();
    const normalStdout = deferred<void>();
    const refusalResultSubmitted = deferred<void>();
    const refusalResultDurability = deferred<void>();
    const refusalStdout = deferred<void>();
    const initializedStdout = deferred<void>();
    sink.resultDurableGate = normalResultDurability.promise;
    sink.resultSubmitted = () => normalResultSubmitted.resolve();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const tool = fictionalTool(async () => envelope({ ok: true }, []));
    const server = buildServer({ auditSink: sink, tools: [tool] });
    await server.connect(new StdioServerTransport(stdin, stdout));
    const bytes: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => {
      bytes.push(Buffer.from(chunk));
      const output = bytes.join("");
      if (output.includes('"id":1')) initializedStdout.resolve();
      if (output.includes('"id":2')) normalStdout.resolve();
      if (output.includes('"id":3')) refusalStdout.resolve();
    });
    try {
      stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "stdio", version: "1" },
          },
        })}\n`,
      );
      await within(initializedStdout.promise, 500, "stdio initialize stdout");
      stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      stdin.write(serializeMessage(callMessage(2, "fictional_tool", { value: "ok" })));
      await within(normalResultSubmitted.promise, 500, "normal result submission");
      expect(sink.events.map((event) => event.phase)).toEqual(["attempt"]);
      expect(bytes.join("")).not.toContain('"id":2');
      normalResultDurability.resolve();
      await within(normalStdout.promise, 500, "normal response stdout");
      expect(bytes.join("")).toContain('"id":2');

      sink.resultDurableGate = refusalResultDurability.promise;
      sink.resultSubmitted = () => refusalResultSubmitted.resolve();
      stdin.write(serializeMessage(callMessage(3, "unknown_secret_tool", {})));
      await within(refusalResultSubmitted.promise, 500, "refusal result submission");
      expect(bytes.join("")).not.toContain('"id":3');
      refusalResultDurability.resolve();
      await within(refusalStdout.promise, 500, "refusal response stdout");
      expect(bytes.join("")).toContain('"id":3');
      await within(server.close(), 500, "stdio server close");
    } finally {
      normalResultDurability.resolve();
      refusalResultDurability.resolve();
      await server.close().catch(() => {});
    }
  });

  test("fresh stdio malformed JSON emits one sanitized protocol error and closes", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const inner = new StdioServerTransport(stdin, stdout);
    const adapter = new AuditedServerTransport({
      inner,
      coordinator,
      actor: () => "agent:stdio-malformed",
      knownTools: new Set(["fictional_tool"]),
    });
    const errors: string[] = [];
    const forwarded: JSONRPCMessage[] = [];
    const writes: string[] = [];
    const closeEntered = deferred<void>();
    let closeCount = 0;
    const errorEntered = deferred<void>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    stdout.on("data", (chunk: Buffer) => writes.push(chunk.toString()));
    adapter.onerror = (error) => {
      errors.push(error.message);
      errorEntered.resolve();
    };
    adapter.onclose = () => {
      closeCount += 1;
      closeEntered.resolve();
    };
    adapter.onmessage = (message) => forwarded.push(message);
    process.on("unhandledRejection", onUnhandled);
    try {
      await adapter.start();
      stdin.write("not-json\n");
      await within(errorEntered.promise, 500, "malformed stdio error");
      await within(adapter.close(), 500, "malformed stdio close");
      await within(adapter.drain(), 500, "malformed stdio drain");
      await within(closeEntered.promise, 500, "malformed stdio close notification");
      expect(closeCount).toBe(1);

      expect(errors).toEqual(["MCP transport protocol error"]);
      expect(forwarded).toHaveLength(0);
      expect(sink.events).toHaveLength(0);
      expect(writes).toHaveLength(0);
      expect(JSON.stringify(errors)).not.toContain("not-json");
      expect(JSON.stringify(errors)).not.toContain("Unexpected token");

      const before = {
        errors: errors.slice(),
        forwarded: forwarded.length,
        audits: sink.events.length,
        output: writes.join(""),
        closes: closeCount,
      };
      stdin.write(serializeMessage(callMessage(0, "fictional_tool", { value: "late" })));
      await quietWindow();
      expect(errors).toEqual(before.errors);
      expect(forwarded).toHaveLength(before.forwarded);
      expect(sink.events).toHaveLength(before.audits);
      expect(writes.join("")).toBe(before.output);
      expect(closeCount).toBe(before.closes);
      expect(closeCount).toBe(1);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await adapter.close().catch(() => {});
    }
  });

  test("fresh stdio JSON-valid schema-invalid input emits one sanitized protocol error and closes", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const inner = new StdioServerTransport(stdin, stdout);
    const adapter = new AuditedServerTransport({
      inner,
      coordinator,
      actor: () => "agent:stdio-schema",
      knownTools: new Set(["fictional_tool"]),
    });
    const errors: string[] = [];
    const forwarded: JSONRPCMessage[] = [];
    const writes: string[] = [];
    const closeEntered = deferred<void>();
    let closeCount = 0;
    const errorEntered = deferred<void>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    stdout.on("data", (chunk: Buffer) => writes.push(chunk.toString()));
    adapter.onerror = (error) => {
      errors.push(error.message);
      errorEntered.resolve();
    };
    adapter.onclose = () => {
      closeCount += 1;
      closeEntered.resolve();
    };
    adapter.onmessage = (message) => forwarded.push(message);
    process.on("unhandledRejection", onUnhandled);
    try {
      await adapter.start();
      stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":[]}\n');
      await within(errorEntered.promise, 500, "schema-invalid stdio error");
      await within(adapter.close(), 500, "schema-invalid stdio close");
      await within(adapter.drain(), 500, "schema-invalid stdio drain");
      await within(closeEntered.promise, 500, "schema-invalid stdio close notification");
      expect(closeCount).toBe(1);

      expect(errors).toEqual(["MCP transport protocol error"]);
      expect(forwarded).toHaveLength(0);
      expect(sink.events).toHaveLength(0);
      expect(writes).toHaveLength(0);
      expect(JSON.stringify(errors)).not.toContain("params");
      expect(JSON.stringify(errors)).not.toContain("Invalid params");
      expect(JSON.stringify(writes)).not.toContain("tools/call");

      const before = {
        errors: errors.slice(),
        forwarded: forwarded.length,
        audits: sink.events.length,
        output: writes.join(""),
        closes: closeCount,
      };
      stdin.write(serializeMessage(callMessage(0, "fictional_tool", { value: "late" })));
      await quietWindow();
      expect(errors).toEqual(before.errors);
      expect(forwarded).toHaveLength(before.forwarded);
      expect(sink.events).toHaveLength(before.audits);
      expect(writes.join("")).toBe(before.output);
      expect(closeCount).toBe(before.closes);
      expect(closeCount).toBe(1);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await adapter.close().catch(() => {});
    }
  });
});

describe("server owner lifecycle", () => {
  test("failed connect keeps successor admission closed until teardown finishes", async () => {
    const server = buildServer({ auditSink: new RecordingSink(), tools: [] });
    const first = new StartRejectingCloseGatedTransport();
    const firstConnect = server.connect(first);
    let successorConnect: Promise<void> | undefined;
    let successor: StartPendingTransport | undefined;
    try {
      await within(first.startEntered.promise, 500, "failed start entry");
      await within(first.closeEntered.promise, 500, "failed start close entry");

      successor = new StartPendingTransport();
      successorConnect = server.connect(successor);
      await expect(
        within(successorConnect, 100, "failed-connect successor admission"),
      ).rejects.toThrow("Minime server is already connected or closing");
      expect(successor.starts).toBe(0);
    } finally {
      first.closeGate.resolve();
      successor?.startGate.resolve();
      successor?.closeGate.resolve();
      await Promise.allSettled([
        firstConnect,
        ...(successorConnect ? [successorConnect] : []),
        server.close(),
      ]);
    }
    await expect(firstConnect).rejects.toThrow(FICTIONAL_START_ERROR);
    expect(first.starts).toBe(1);
    expect(first.closes).toBe(1);
  });

  test("close during a pending start makes late connect resolution reject", async () => {
    const server = buildServer({ auditSink: new RecordingSink(), tools: [] });
    const transport = new StartPendingTransport();
    const connecting = server.connect(transport);
    let closing: Promise<void> | undefined;
    try {
      await within(transport.startEntered.promise, 500, "pending start entry");
      closing = server.close();
      await within(transport.closeEntered.promise, 500, "pending start close entry");
      transport.startGate.resolve();
      transport.closeGate.resolve();

      await expect(within(connecting, 500, "late connect settlement")).rejects.toThrow(
        "Minime connection closed during connect",
      );
      await within(closing, 500, "close during connect");
      expect(transport.starts).toBe(1);
      expect(transport.closes).toBe(1);
    } finally {
      transport.startGate.resolve();
      transport.closeGate.resolve();
      await Promise.allSettled([connecting, ...(closing ? [closing] : []), server.close()]);
    }
  });

  test("reentrant teardown is identity-owned and late callbacks cannot clear a successor", async () => {
    const server = buildServer({ auditSink: new RecordingSink(), tools: [] });
    const first = new StartRejectingCloseGatedTransport();
    const firstConnect = server.connect(first);
    await within(first.startEntered.promise, 500, "first owner start");
    await within(first.closeEntered.promise, 500, "first owner close");
    first.closeGate.resolve();
    await expect(firstConnect).rejects.toThrow(FICTIONAL_START_ERROR);
    expect(first.closes).toBe(1);

    const successor = new StartPendingTransport();
    const successorConnect = server.connect(successor);
    await within(successor.startEntered.promise, 500, "successor start");
    successor.startGate.resolve();
    await within(successorConnect, 500, "successor connect");

    first.fireRetainedClose();
    await quietWindow();
    expect(successor.closes).toBe(0);

    const third = new StartPendingTransport();
    const thirdConnect = server.connect(third);
    await expect(within(thirdConnect, 100, "third owner admission")).rejects.toThrow(
      "Minime server is already connected or closing",
    );
    expect(third.starts).toBe(0);

    const firstClose = server.close();
    await within(successor.closeEntered.promise, 500, "successor close entry");
    const secondClose = server.close();
    expect(secondClose).toBe(firstClose);
    successor.fireRetainedClose();
    successor.closeGate.resolve();
    await within(Promise.all([firstClose, secondClose]), 500, "shared successor teardown");
    expect(successor.closes).toBe(1);

    third.startGate.resolve();
    third.closeGate.resolve();
    await Promise.allSettled([thirdConnect, server.close()]);
  });
});
