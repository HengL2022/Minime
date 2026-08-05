import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import {
  RequestIdSchema,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import { requestedNameHash } from "./audit";
import type {
  AuditCoordinator,
  AuditedCallMeta,
  OutboundClaim,
  OutboundCorrelation,
} from "./audit-coordinator";

export type RawToolCallMeta = AuditedCallMeta;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return RequestIdSchema.safeParse(value).success;
}

function validTask(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!Object.hasOwn(value, "ttl")) return true;
  return typeof value.ttl === "number" && Number.isFinite(value.ttl);
}

export function rawToolCallMeta(
  message: JSONRPCMessage,
  actor: string,
  knownTools: ReadonlySet<string>,
): RawToolCallMeta | null {
  const requestRecord: Record<string, unknown> | undefined = isRecord(message)
    ? message
    : undefined;
  if (!isJSONRPCRequest(message)) return null;
  if (!requestRecord || requestRecord.method !== "tools/call") return null;
  const params = isRecord(requestRecord.params) ? requestRecord.params : undefined;
  const args = params?.arguments;
  const argsAreValid = params !== undefined && (args === undefined || isRecord(args));
  const paramsForAudit =
    params === undefined ? {} : argsAreValid ? (args ?? {}) : requestRecord.params;
  const rawName = params?.name;
  const known = typeof rawName === "string" && knownTools.has(rawName);
  const tool = known ? rawName : "unknown";
  const nameHash = known ? undefined : requestedNameHash(rawName ?? null);
  const taskPresent = params !== undefined && Object.hasOwn(params, "task");
  const taskIsValid = !taskPresent || validTask(params?.task);
  let refusalClass: AuditedCallMeta["refusalClass"];
  if (!params || !argsAreValid || !taskIsValid || typeof rawName !== "string")
    refusalClass = "malformed";
  else if (known && taskPresent) refusalClass = "task";
  else if (!known) refusalClass = "unknown";
  else refusalClass = "known";
  return {
    requestId: message.id,
    actor,
    tool,
    paramsForAudit,
    ...(nameHash ? { requestedNameHash: nameHash } : {}),
    refusalClass,
  };
}

function cancellationRequestId(message: JSONRPCMessage): RequestId | undefined {
  const record: Record<string, unknown> | undefined = isRecord(message) ? message : undefined;
  if (!record || !isJSONRPCNotification(message) || record.method !== "notifications/cancelled") {
    return undefined;
  }
  const params = record.params;
  if (!isRecord(params) || !Object.hasOwn(params, "requestId")) return undefined;
  const parsed = RequestIdSchema.safeParse(params.requestId);
  return parsed.success ? parsed.data : undefined;
}

export class AuditedServerTransport implements Transport {
  private started = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly tracked = new Set<Promise<void>>();
  private outwardCloseNotified = false;
  private outwardErrorNotified = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly options: {
      inner: Transport;
      coordinator: AuditCoordinator;
      actor: () => string;
      knownTools: ReadonlySet<string>;
    },
  ) {}

  get sessionId(): string | undefined {
    return this.options.inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.options.inner.setProtocolVersion?.(version);
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.closing) return Promise.reject(new Error("audited MCP transport is closing"));
    this.started = true;
    this.options.inner.onmessage = (message, extra) => {
      this.track(this.processIncoming(message, extra));
    };
    this.options.inner.onerror = () => {
      this.reportError("MCP transport protocol error");
      void this.beginClose(true);
    };
    this.options.inner.onclose = () => {
      this.scheduleClose();
    };
    return this.options.inner.start();
  }

  private track(task: Promise<void>): void {
    const observed = task.catch(() => {});
    this.tracked.add(observed);
    void observed.finally(() => this.tracked.delete(observed));
  }

  private reportError(message: string): void {
    if (this.outwardErrorNotified) return;
    this.outwardErrorNotified = true;
    try {
      this.onerror?.(new Error(message));
    } catch {
      // An observer must not prevent the fail-closed path from draining.
    }
  }

  private notifyClose(): void {
    if (this.outwardCloseNotified) return;
    this.outwardCloseNotified = true;
    try {
      this.onclose?.();
    } catch {
      // Closing remains complete even if an observer fails.
    }
  }

  private scheduleClose(): void {
    if (this.closePromise) return;
    queueMicrotask(() => {
      void this.close();
    });
  }

  private beginClose(immediateInnerClose: boolean): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    this.closePromise = closePromise;
    const innerClose = immediateInnerClose ? this.options.inner.close().catch(() => {}) : undefined;
    void (async () => {
      await this.options.coordinator.transportClosed().catch(() => {
        this.reportError("audited MCP transport failure");
      });
      if (innerClose) await innerClose;
      else await this.options.inner.close().catch(() => {});
      while (this.tracked.size) {
        const pending = [...this.tracked];
        await Promise.all(pending);
      }
      await this.options.coordinator.drain().catch(() => {});
      this.notifyClose();
      resolveClose();
    })();
    return closePromise;
  }

  private failClosed(): void {
    this.reportError("audited MCP transport failure");
    this.scheduleClose();
  }

  private async processIncoming(message: JSONRPCMessage, extra?: MessageExtraInfo): Promise<void> {
    try {
      if (this.closing) return;
      const cancellationId = cancellationRequestId(message);
      if (cancellationId !== undefined) {
        const cancellation = await this.options.coordinator.cancel(cancellationId);
        if (cancellation.forwardNotification) this.onmessage?.(message, extra);
        if (cancellation.closeTransport) this.scheduleClose();
        return;
      }

      const meta = rawToolCallMeta(message, this.options.actor(), this.options.knownTools);
      if (!meta) {
        this.onmessage?.(message, extra);
        return;
      }
      const decision = await this.options.coordinator.receiveCall(meta);
      if (decision.action === "forward") {
        this.onmessage?.(message, extra);
      } else if (decision.action === "respond") {
        try {
          await this.options.inner.send(
            { jsonrpc: "2.0", id: meta.requestId, result: decision.result },
            { relatedRequestId: meta.requestId },
          );
        } finally {
          await this.options.coordinator.completeDirectResponse(
            meta.requestId,
            decision.generation,
          );
        }
      } else if (decision.closeTransport) {
        this.scheduleClose();
      }
    } catch {
      this.failClosed();
    }
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (this.closing) return Promise.resolve();
    const task = this.sendInternal(message, options);
    this.track(task);
    return task;
  }

  private async sendInternal(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    const hasResponseId =
      (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
      isRequestId(message.id);
    let requestId: RequestId | undefined;
    if (hasResponseId) requestId = message.id;
    try {
      const decision = await this.options.coordinator.handleOutbound(message);
      if (decision.action === "untracked") {
        await this.options.inner.send(decision.message, options);
        return;
      }
      const outbound = decision.message;
      const correlation: OutboundCorrelation = decision.correlation;
      let claim: OutboundClaim | undefined;
      if (requestId !== undefined) {
        claim =
          correlation.kind !== "untracked" && correlation.result === "no_result"
            ? await this.options.coordinator.claimNoResultOutbound(requestId, correlation)
            : await this.options.coordinator.claimOutbound(requestId, correlation);
        if (claim.action === "drop") {
          if (claim.completion === "required") {
            if (correlation.kind !== "untracked" && correlation.result === "no_result") {
              await this.options.coordinator.completeNoResultOutbound(requestId, claim.generation);
            } else {
              await this.options.coordinator.completeOutbound(requestId, claim.generation, {
                status: "suppressed",
                ...(claim.outcome ? { outcome: claim.outcome } : {}),
              });
            }
          }
          return;
        }
        if (claim.action === "untracked") {
          await this.options.inner.send(outbound, options);
          return;
        }
      }
      const sendOptions =
        outbound === message && requestId !== undefined
          ? options
          : outbound === message
            ? options
            : requestId === undefined
              ? options
              : { ...options, relatedRequestId: requestId };
      let sendFailed = false;
      try {
        await this.options.inner.send(outbound, sendOptions);
      } catch (error) {
        sendFailed = true;
        throw error;
      } finally {
        if (requestId !== undefined && claim?.action === "send") {
          if (correlation.kind !== "untracked" && correlation.result === "no_result") {
            await this.options.coordinator.completeNoResultOutbound(requestId, claim.generation);
          } else {
            await this.options.coordinator.completeOutbound(requestId, claim.generation, {
              status: sendFailed ? "send_uncertain" : "released",
            });
          }
        }
      }
    } catch {
      this.failClosed();
      throw new Error("audited MCP transport failure");
    }
  }

  async close(): Promise<void> {
    return this.beginClose(false);
  }

  async drain(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }
    while (this.tracked.size) await Promise.all([...this.tracked]);
    await this.options.coordinator.drain();
  }
}
