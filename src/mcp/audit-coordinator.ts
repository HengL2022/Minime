import type { CallToolResult, JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { AuditDisposition, AuditOutcome, AuditSink, ResultAuditRecord } from "./audit";
import {
  ATTEMPT_FAILURE_RESULT,
  AUDIT_UNAVAILABLE_RESULT,
  COMPLETED_RESULT_WITHHELD,
  INTERNAL_EXECUTION_RESULT,
} from "./tools/registry";

export interface AuditedCallMeta {
  requestId: RequestId;
  actor: string;
  tool: string;
  paramsForAudit: unknown;
  requestedNameHash?: string;
  refusalClass: "known" | "unknown" | "malformed" | "task";
}

export type InboundDecision =
  | { action: "forward" }
  | { action: "respond"; result: CallToolResult; generation: symbol }
  | { action: "drop"; closeTransport: boolean };

export type OutboundResultKind = "durable" | "no_result";

export type OutboundCorrelation =
  | { kind: "pending"; generation: symbol; result: "durable" }
  | { kind: "pending"; generation: symbol; result: "no_result" }
  | { kind: "tombstone"; generation: symbol; result: "durable" }
  | { kind: "tombstone"; generation: symbol; result: "no_result" }
  | { kind: "untracked" };

export type NoResultOutboundCorrelation = Extract<OutboundCorrelation, { result: "no_result" }>;

export type OutboundDecision =
  | { action: "send"; message: JSONRPCMessage; correlation: OutboundCorrelation }
  | { action: "drop"; message: JSONRPCMessage; correlation: OutboundCorrelation }
  | { action: "untracked"; message: JSONRPCMessage; correlation: { kind: "untracked" } };

export type OutboundClaim =
  | { action: "send"; generation: symbol }
  | {
      action: "drop";
      generation: symbol;
      completion: "required" | "none";
      outcome?: AuditOutcome;
    }
  | { action: "untracked" };

export type NoResultOutboundClaim = Exclude<OutboundClaim, { action: "untracked" }>;

export interface CallbackResult {
  callToolResult: CallToolResult;
  returnedIds: string[];
  returnedCount: number;
  ok: boolean;
  error?: string;
}

export interface CoordinatorHooks {
  afterForwardDecision?(requestId: RequestId): Promise<void>;
  beforeCallbackStart?(requestId: RequestId): Promise<void>;
  afterHandlerResult?(requestId: RequestId): Promise<void>;
  beforeOutboundClaim?(requestId: RequestId): Promise<void>;
  beforeNoResultCompletion?(requestId: RequestId): Promise<void>;
}

interface TerminalAuditResult {
  audited: boolean;
  outcome?: AuditOutcome;
}

const SUPPRESSED_CALL_RESULT = {
  isError: true,
  content: [],
} as const satisfies CallToolResult;

interface PendingCall {
  requestId: RequestId;
  generation: symbol;
  actor: string;
  tool: string;
  paramsHash?: string;
  resultEventId?: string;
  requestedNameHash?: string;
  refusalClass: AuditedCallMeta["refusalClass"];
  phase: "attempt_pending" | "forwarded" | "running" | "result_auditing" | "result_audited";
  queuedOutcome?: "cancel" | "close";
  release: "pending" | "send" | "drop";
  terminalReplacement?: "audit_unavailable" | "completed_result_withheld";
  terminalAuditStarted: boolean;
  deliveryState: "no_result" | "result_pending" | "preclaim" | "release_claimed" | "disposed";
  dispositionAttempted: boolean;
  executionStarted: boolean;
  committedOutcome?: AuditOutcome;
  attemptFailure?: boolean;
  callbackObserved: boolean;
  dispositionPromise?: Promise<void>;
  noResultCompletionStarted: boolean;
  settlement: Promise<void>;
  resolveSettlement: () => void;
  chain: Promise<void>;
}

function outcomeFor(entry: PendingCall): AuditOutcome {
  return entry.queuedOutcome === "close"
    ? entry.executionStarted
      ? "completed_after_disconnect"
      : "transport_closed_before_execution"
    : entry.executionStarted
      ? "completed_not_released"
      : "cancelled_before_execution";
}

function refusalCode(entry: PendingCall): string {
  if (entry.refusalClass === "task") return "SDK_REFUSAL";
  if (entry.refusalClass === "unknown") return "UNKNOWN_TOOL";
  return "BAD_INPUT";
}

export class AuditCoordinator {
  private readonly pending = new Map<RequestId, PendingCall>();
  private readonly tombstones = new Map<RequestId, symbol>();
  private readonly tombstoneResults = new Map<RequestId, OutboundResultKind>();
  private readonly hooks: CoordinatorHooks;

  constructor(auditSink: AuditSink, hooks: CoordinatorHooks = {}) {
    this.auditSink = auditSink;
    this.hooks = hooks;
  }

  private readonly auditSink: AuditSink;

  private queue(entry: PendingCall, transition: () => Promise<void> | void): Promise<void> {
    const next = entry.chain.then(transition, transition);
    entry.chain = next.catch(() => {});
    return next;
  }

  private async ensureDisposition(
    entry: PendingCall,
    disposition: AuditDisposition,
  ): Promise<void> {
    if (!entry.resultEventId) return;
    if (entry.dispositionAttempted) {
      if (entry.dispositionPromise) return entry.dispositionPromise;
      return;
    }
    entry.dispositionAttempted = true;
    let append: Promise<void>;
    try {
      append = this.auditSink.disposition(
        entry.actor,
        entry.tool,
        entry.resultEventId,
        disposition,
      );
    } catch (error: unknown) {
      append = Promise.reject(error);
    }
    const operation = append.finally(() => {
      entry.deliveryState = "disposed";
    });
    entry.dispositionPromise = operation;
    return operation;
  }

  private async suppress(entry: PendingCall): Promise<void> {
    if (
      !entry.resultEventId ||
      entry.deliveryState === "release_claimed" ||
      entry.deliveryState === "disposed"
    )
      return;
    entry.release = "drop";
    await this.ensureDisposition(entry, {
      status: "suppressed",
      outcome: entry.queuedOutcome ? outcomeFor(entry) : entry.committedOutcome,
    });
  }

  private async terminalAudit(
    entry: PendingCall,
    ids: string[],
    count: number,
    error?: string,
  ): Promise<TerminalAuditResult> {
    if (entry.terminalAuditStarted) {
      return {
        audited:
          !!entry.resultEventId &&
          entry.deliveryState !== "no_result" &&
          !entry.terminalReplacement,
        outcome: entry.committedOutcome,
      };
    }
    entry.terminalAuditStarted = true;
    entry.phase = "result_auditing";
    entry.deliveryState = "result_pending";
    const authorizeReturnedData = entry.queuedOutcome === undefined;
    const record: ResultAuditRecord = {
      returnedIds: authorizeReturnedData ? ids : [],
      returnedCount: authorizeReturnedData ? count : 0,
      ...(error ? { error } : {}),
      delivery: "transport",
    };
    let durable: { eventId: string };
    try {
      durable = await this.auditSink.result(
        entry.actor,
        entry.tool,
        entry.paramsHash ?? "",
        record,
        entry.requestedNameHash,
      );
    } catch {
      entry.phase = "result_audited";
      entry.deliveryState = "no_result";
      entry.release = entry.queuedOutcome ? "drop" : "pending";
      entry.terminalReplacement = "audit_unavailable";
      return { audited: false, outcome: entry.committedOutcome };
    }
    entry.resultEventId = durable.eventId;
    entry.phase = "result_audited";
    entry.deliveryState = "preclaim";
    entry.committedOutcome = entry.queuedOutcome ? outcomeFor(entry) : undefined;
    entry.release = entry.queuedOutcome ? "drop" : entry.release;
    if (entry.queuedOutcome) await this.suppress(entry);
    return { audited: true, outcome: entry.committedOutcome };
  }

  private async terminalBeforeExecution(entry: PendingCall): Promise<void> {
    if (entry.terminalAuditStarted) return;
    const retainForOutbound = entry.phase === "forwarded" || entry.callbackObserved;
    await this.terminalAudit(entry, [], 0);
    if (
      entry.resultEventId &&
      entry.release === "drop" &&
      !retainForOutbound &&
      this.pending.get(entry.requestId) === entry
    ) {
      await this.retireAfterDisposition(entry);
    } else if (
      !entry.resultEventId &&
      entry.release === "drop" &&
      !retainForOutbound &&
      this.pending.get(entry.requestId) === entry
    ) {
      this.retireCurrent(entry);
    }
  }

  private discardUnforwarded(entry: PendingCall): void {
    if (!entry.callbackObserved && this.pending.get(entry.requestId) === entry) {
      if (entry.resultEventId && !entry.dispositionPromise) {
        this.retireCurrent(entry);
      } else if (!entry.resultEventId) {
        this.retireCurrent(entry);
      }
    }
  }

  async receiveCall(meta: AuditedCallMeta): Promise<InboundDecision> {
    if (this.pending.has(meta.requestId) || this.tombstones.has(meta.requestId)) {
      let hash = "";
      try {
        hash = await this.auditSink.attempt(
          meta.actor,
          meta.tool,
          meta.paramsForAudit,
          meta.requestedNameHash,
        );
      } catch {
        return { action: "drop", closeTransport: true };
      }
      try {
        const duplicateResult = await this.auditSink.result(
          meta.actor,
          meta.tool,
          hash,
          {
            returnedIds: [],
            returnedCount: 0,
            error: "DUPLICATE_REQUEST_ID",
            delivery: "transport",
          },
          meta.requestedNameHash,
        );
        try {
          await this.auditSink.disposition(meta.actor, meta.tool, duplicateResult.eventId, {
            status: "suppressed",
          });
        } catch {
          // A failed duplicate disposition remains fail-closed and is never retried.
        }
      } catch {
        // Fail closed. A duplicate never obtains an outbound result.
      }
      return { action: "drop", closeTransport: true };
    }

    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    const entry: PendingCall = {
      requestId: meta.requestId,
      generation: Symbol(),
      actor: meta.actor,
      tool: meta.tool,
      requestedNameHash: meta.requestedNameHash,
      refusalClass: meta.refusalClass,
      phase: "attempt_pending",
      release: "pending",
      terminalAuditStarted: false,
      deliveryState: "no_result",
      dispositionAttempted: false,
      executionStarted: false,
      callbackObserved: false,
      noResultCompletionStarted: false,
      settlement,
      resolveSettlement,
      chain: Promise.resolve(),
    };
    this.pending.set(entry.requestId, entry);
    const paramsForAudit = meta.paramsForAudit;
    const attempt = this.queue(entry, async () => {
      try {
        entry.paramsHash = await this.auditSink.attempt(
          entry.actor,
          entry.tool,
          paramsForAudit,
          entry.requestedNameHash,
        );
      } catch {
        entry.attemptFailure = true;
        return;
      }
      if (entry.queuedOutcome) await this.terminalBeforeExecution(entry);
      else entry.phase = "forwarded";
    });
    await attempt;

    if (entry.attemptFailure) {
      return { action: "respond", result: ATTEMPT_FAILURE_RESULT, generation: entry.generation };
    }
    if (entry.terminalAuditStarted) {
      this.discardUnforwarded(entry);
      return { action: "drop", closeTransport: false };
    }
    await this.hooks.afterForwardDecision?.(entry.requestId);
    if (entry.terminalAuditStarted) {
      this.discardUnforwarded(entry);
      return { action: "drop", closeTransport: false };
    }
    return { action: "forward" };
  }

  async cancel(
    requestId: RequestId,
  ): Promise<{ forwardNotification: boolean; closeTransport: boolean }> {
    const entry = this.pending.get(requestId);
    if (!entry) return { forwardNotification: true, closeTransport: false };
    if (entry.release === "send" || entry.deliveryState === "release_claimed") {
      return { forwardNotification: false, closeTransport: false };
    }
    entry.queuedOutcome ??= "cancel";
    entry.release = "drop";
    await this.queue(entry, async () => {
      if (entry.attemptFailure) return;
      if (entry.terminalAuditStarted) {
        if (entry.resultEventId) await this.suppress(entry);
        else entry.release = "drop";
        return;
      }
      if (entry.phase === "running") return;
      await this.terminalBeforeExecution(entry);
    });
    return { forwardNotification: false, closeTransport: false };
  }

  async transportClosed(): Promise<void> {
    const entries = [...this.pending.values()];
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.release === "send" || entry.deliveryState === "release_claimed") return;
        entry.queuedOutcome ??= "close";
        entry.release = "drop";
        await this.queue(entry, async () => {
          if (entry.attemptFailure) return;
          if (entry.terminalAuditStarted) {
            if (entry.resultEventId) await this.suppress(entry);
            else entry.release = "drop";
            return;
          }
          if (entry.phase === "running") return;
          await this.terminalBeforeExecution(entry);
        });
      }),
    );
  }

  async drain(): Promise<void> {
    await this.transportClosed().catch(() => {});
    while (this.pending.size) {
      const entries = [...this.pending.values()];
      await Promise.all(entries.map((entry) => entry.chain.catch(() => {})));
      if (entries.every((entry) => !this.pending.has(entry.requestId))) break;
      const claimedSettlements: Promise<void>[] = [];
      for (const entry of entries) {
        if (entry.phase !== "result_audited") continue;
        if (entry.deliveryState === "release_claimed" || entry.release === "send") {
          claimedSettlements.push(entry.settlement);
          continue;
        }
        if (entry.resultEventId) {
          const disposition: AuditDisposition = {
            status: "suppressed",
            ...(entry.queuedOutcome ? { outcome: outcomeFor(entry) } : {}),
          };
          await this.completeOutbound(entry.requestId, entry.generation, disposition).catch(
            () => {},
          );
        } else {
          await this.completeNoResultOutbound(entry.requestId, entry.generation).catch(() => {});
        }
      }
      if (claimedSettlements.length) await Promise.race(claimedSettlements);
      await Promise.resolve();
    }
  }

  async handleCallback(
    requestId: RequestId,
    execute: () => Promise<CallbackResult>,
  ): Promise<CallToolResult> {
    const entry = this.pending.get(requestId);
    if (!entry) return SUPPRESSED_CALL_RESULT;
    entry.callbackObserved = true;
    let response: CallToolResult = SUPPRESSED_CALL_RESULT;
    await this.queue(entry, async () => {
      if (entry.terminalAuditStarted) {
        response =
          entry.committedOutcome || entry.release === "drop"
            ? SUPPRESSED_CALL_RESULT
            : entry.terminalReplacement === "completed_result_withheld"
              ? COMPLETED_RESULT_WITHHELD
              : entry.terminalReplacement
                ? AUDIT_UNAVAILABLE_RESULT
                : SUPPRESSED_CALL_RESULT;
        return;
      }
      if (entry.queuedOutcome) {
        await this.terminalBeforeExecution(entry);
        response =
          entry.committedOutcome || entry.release === "drop"
            ? SUPPRESSED_CALL_RESULT
            : entry.terminalReplacement
              ? AUDIT_UNAVAILABLE_RESULT
              : SUPPRESSED_CALL_RESULT;
        return;
      }
      if (entry.refusalClass === "task") {
        await this.terminalAudit(entry, [], 0, "SDK_REFUSAL");
        response = SUPPRESSED_CALL_RESULT;
        return;
      }
      let callback: CallbackResult;
      try {
        await this.hooks.beforeCallbackStart?.(requestId);
        if (entry.queuedOutcome) {
          await this.terminalBeforeExecution(entry);
          response =
            entry.committedOutcome || entry.release === "drop"
              ? SUPPRESSED_CALL_RESULT
              : entry.terminalReplacement === "audit_unavailable"
                ? AUDIT_UNAVAILABLE_RESULT
                : SUPPRESSED_CALL_RESULT;
          return;
        }
        entry.phase = "running";
        entry.executionStarted = true;
        callback = await execute();
        if (!callback || typeof callback !== "object") throw new Error("invalid callback result");
        await this.hooks.afterHandlerResult?.(requestId);
      } catch {
        callback = {
          ok: false,
          callToolResult: INTERNAL_EXECUTION_RESULT,
          returnedIds: [],
          returnedCount: 0,
          error: "INTERNAL",
        };
      }
      const audit = await this.terminalAudit(
        entry,
        callback.ok ? callback.returnedIds : [],
        callback.ok ? callback.returnedCount : 0,
        callback.error,
      );
      if (audit.outcome || entry.release === "drop") {
        response = SUPPRESSED_CALL_RESULT;
      } else if (!audit.audited) {
        entry.terminalReplacement = callback.ok ? "completed_result_withheld" : "audit_unavailable";
        response = callback.ok ? COMPLETED_RESULT_WITHHELD : AUDIT_UNAVAILABLE_RESULT;
      } else {
        response = callback.callToolResult;
      }
    }).catch(() => {
      response = AUDIT_UNAVAILABLE_RESULT;
      entry.phase = "result_audited";
      entry.release = "drop";
      entry.terminalReplacement = "audit_unavailable";
    });
    return response;
  }

  async handleOutbound(message: JSONRPCMessage): Promise<OutboundDecision> {
    if (!("id" in message) || (typeof message.id !== "string" && typeof message.id !== "number")) {
      return { action: "send", message, correlation: { kind: "untracked" } };
    }
    const requestId = message.id;
    const entry = this.pending.get(requestId);
    const tombstoneGeneration = this.tombstones.get(requestId);
    const correlation: OutboundCorrelation = entry
      ? {
          kind: "pending",
          generation: entry.generation,
          result: entry.resultEventId ? "durable" : "no_result",
        }
      : tombstoneGeneration
        ? {
            kind: "tombstone",
            generation: tombstoneGeneration,
            result: this.tombstoneResults.get(requestId) ?? "durable",
          }
        : { kind: "untracked" };
    if (correlation.kind === "untracked") {
      return { action: "untracked", message, correlation };
    }
    if (!entry) return { action: "send", message, correlation };
    await this.queue(entry, async () => {
      if (entry.phase !== "forwarded" || entry.terminalAuditStarted) return;
      const audit = await this.terminalAudit(entry, [], 0, refusalCode(entry));
      if (!audit.audited) entry.terminalReplacement = "audit_unavailable";
    }).catch(() => {
      entry.terminalReplacement = "audit_unavailable";
      entry.phase = "result_audited";
      entry.release = "drop";
    });
    const resolvedCorrelation: OutboundCorrelation =
      correlation.kind === "pending"
        ? {
            kind: "pending",
            generation: correlation.generation,
            result: entry.resultEventId ? "durable" : "no_result",
          }
        : correlation;
    if (entry.terminalReplacement === "audit_unavailable") {
      return {
        action: "send",
        message: {
          jsonrpc: "2.0",
          id: requestId,
          result: AUDIT_UNAVAILABLE_RESULT,
        },
        correlation: resolvedCorrelation,
      };
    }
    return { action: "send", message, correlation: resolvedCorrelation };
  }

  private claimTrackedOutbound(
    requestId: RequestId,
    captured: Exclude<OutboundCorrelation, { kind: "untracked" }>,
  ): NoResultOutboundClaim {
    if (captured.kind === "tombstone") {
      return { action: "drop", generation: captured.generation, completion: "none" };
    }
    const entry = this.pending.get(requestId);
    if (!entry || entry.generation !== captured.generation) {
      return { action: "drop", generation: captured.generation, completion: "none" };
    }
    if (captured.result !== "durable" || !entry.resultEventId) {
      return { action: "drop", generation: captured.generation, completion: "none" };
    }
    if (entry.release === "drop" || entry.queuedOutcome) {
      entry.release = "drop";
      return {
        action: "drop",
        generation: entry.generation,
        completion: "required",
        ...(entry.committedOutcome ? { outcome: entry.committedOutcome } : {}),
      };
    }
    if (entry.deliveryState !== "preclaim") {
      return { action: "drop", generation: captured.generation, completion: "none" };
    }
    if (entry.release === "send") {
      return {
        action: "drop",
        generation: entry.generation,
        completion: "none",
      };
    }
    entry.release = "send";
    entry.deliveryState = "release_claimed";
    return { action: "send", generation: entry.generation };
  }

  async claimOutbound(
    requestId: RequestId,
    correlation: OutboundCorrelation,
  ): Promise<OutboundClaim> {
    if (correlation.kind === "untracked") return { action: "untracked" };
    if (correlation.result === "no_result") {
      return this.claimNoResultOutbound(requestId, correlation);
    }
    await this.hooks.beforeOutboundClaim?.(requestId);
    return this.claimTrackedOutbound(requestId, correlation);
  }

  async claimNoResultOutbound(
    requestId: RequestId,
    correlation: NoResultOutboundCorrelation,
  ): Promise<NoResultOutboundClaim> {
    await this.hooks.beforeOutboundClaim?.(requestId);
    if (correlation.result !== "no_result") {
      return { action: "drop", generation: correlation.generation, completion: "none" };
    }
    if (correlation.kind === "tombstone") {
      return { action: "drop", generation: correlation.generation, completion: "none" };
    }
    const entry = this.pending.get(requestId);
    if (!entry || entry.generation !== correlation.generation) {
      return { action: "drop", generation: correlation.generation, completion: "none" };
    }
    if (
      entry.deliveryState !== "no_result" ||
      !entry.terminalReplacement ||
      entry.noResultCompletionStarted
    ) {
      return { action: "drop", generation: correlation.generation, completion: "none" };
    }
    if (entry.release === "send") {
      return { action: "drop", generation: entry.generation, completion: "none" };
    }
    if (entry.release === "drop" || entry.queuedOutcome) {
      entry.release = "drop";
      return {
        action: "drop",
        generation: entry.generation,
        completion: "required",
        ...(entry.committedOutcome ? { outcome: entry.committedOutcome } : {}),
      };
    }
    entry.release = "send";
    return { action: "send", generation: entry.generation };
  }

  async completeOutbound(
    requestId: RequestId,
    generation: symbol,
    disposition: AuditDisposition,
  ): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.generation !== generation) return;
    await entry.chain.catch(() => {});
    if (!entry.resultEventId) {
      await this.completeNoResultOutbound(requestId, entry.generation);
      return;
    }
    if (
      entry.deliveryState === "release_claimed" &&
      disposition.status !== "released" &&
      disposition.status !== "send_uncertain"
    ) {
      throw new Error("claimed outbound completion requires released or send_uncertain");
    }
    if (
      entry.deliveryState !== "release_claimed" &&
      (disposition.status === "released" || disposition.status === "send_uncertain")
    ) {
      throw new Error("released outbound completion requires a send claim");
    }
    try {
      await this.ensureDisposition(entry, disposition);
    } finally {
      this.retireCurrent(entry);
    }
  }

  async completeNoResultOutbound(requestId: RequestId, generation: symbol): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.generation !== generation) return;
    if (entry.noResultCompletionStarted) return;
    entry.noResultCompletionStarted = true;
    try {
      await this.hooks.beforeNoResultCompletion?.(requestId);
    } finally {
      this.retireCurrent(entry);
    }
  }

  async completeDirectResponse(requestId: RequestId, generation: symbol): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.generation !== generation) return;
    await entry.chain.catch(() => {});
    this.retireCurrent(entry);
  }

  private async retireAfterDisposition(entry: PendingCall): Promise<void> {
    if (entry.dispositionPromise) {
      await entry.dispositionPromise;
    }
    this.retireCurrent(entry);
  }

  private retireCurrent(entry: PendingCall): void {
    if (this.pending.get(entry.requestId) !== entry) return;
    this.pending.delete(entry.requestId);
    entry.resolveSettlement();
    this.tombstones.set(entry.requestId, entry.generation);
    this.tombstoneResults.set(entry.requestId, entry.resultEventId ? "durable" : "no_result");
    const token = entry.generation;
    queueMicrotask(() => {
      if (this.tombstones.get(entry.requestId) === token) {
        this.tombstones.delete(entry.requestId);
        this.tombstoneResults.delete(entry.requestId);
      }
    });
  }

  pendingCount(): number {
    return this.pending.size + this.tombstones.size;
  }
}
