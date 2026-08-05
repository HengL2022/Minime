# H4 Durable Tool-Attempt Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee a durable append-only attempt before any MCP tool validation/handler effect and a durable result/disclosure record before any response bytes are released.

**Architecture:** Card 1 splits unaudited `executeTool()` from source-compatible direct `invokeTool()`, introduces phase-specific `AuditSink`, and implements the per-request `AuditCoordinator` state machine. Card 2 makes `buildServer()` return a transport-only facade and connects its private SDK `McpServer` through an audited `Transport` adapter that sees raw `tools/call`, cancellation, close, callback `extra.requestId`, and outbound SDK refusals. Card 3 locks schema/wire/leak/access/race compatibility through public SDK 1.29.0 interfaces, then records the decision and runs the complete branch gate.

**Tech Stack:** Bun/TypeScript, PostgreSQL 16 append-only `events`, Zod, `@modelcontextprotocol/sdk` resolved and locked at 1.29.0 under manifest range `^1.12.0`, public MCP `Transport`/JSON-RPC/`CallToolResult` interfaces, `InMemoryTransport`, `StdioServerTransport`, Node `PassThrough`, `bun test`.

## Global Constraints

- Start `codex/hardening-audit-attempt` only from the exact binding-reviewed H1 branch SHA.
- Use the pinned ignored worktree `.claude/worktrees/hardening-audit-attempt`, record its
  initial head as `START_SHA`, and scope every status, ledger, diff, gate, and review command
  to that worktree.
- Final review diffs must be generated from the recorded `START_SHA` (for example,
  `git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD -- <upfront-map-paths>`), never from an
  implicit working-tree baseline. Any review scratch checkout, tools/list capture, or
  diagnostic output must live under a fresh directory outside the repository and outside
  untracked owner directories, with unconditional cleanup; do not create scratch files under
  `data/`, `db-dump/`, `.claude/worktrees/`, or the repository root.
- Preserve I2 one door, I3 tiered egress, I7 honest envelopes, and I8 append-only audit.
- Audit boundary is receipt of a schema-valid JSON-RPC request whose method is exactly `tools/call`, before SDK tool-specific validation, timezone parsing, or handler execution.
- Malformed bytes that cannot become a JSON-RPC message remain a transport error and do not create a tool-attempt event.
- Every known call uses `tool:<name>:attempt` then the compatible `tool:<name>` result verb.
- Unknown or non-string names use only `tool:unknown:attempt` and `tool:unknown`; the raw requested name never enters an event verb or payload.
- `requested_name_hash` is the first 16 lowercase hex characters of SHA-256 over UTF-8 `JSON.stringify(raw params.name ?? null)` and appears in both phases only for unknown/non-string names.
- Attempt payload contains only `params_hash` and optional `requested_name_hash`.
- Result payload retains `params_hash`, `returned_ids`, `returned_count`, and optional `error`, `outcome`, `requested_name_hash`.
- A result carrying any non-release `outcome` (`cancelled_before_execution`,
  `transport_closed_before_execution`, `completed_not_released`, or
  `completed_after_disconnect`) must carry `returned_ids:[]` and `returned_count:0`, even
  when the handler had produced IDs internally. A normal released success keeps the existing
  positive IDs/count behavior; this is an event-payload invariant, not an access-ranking
  redesign.
- Returned IDs come only from the final redacted envelope authorized for release.
- Attempt failure prevents SDK forwarding, tool-specific parsing, timezone parsing, filesystem/DB/model/index effects, and handler execution.
- No normal success, handler error, SDK refusal, data, or source ID is released before its result audit is durable.
- Result-audit failure after successful execution returns only the fixed non-retry completion acknowledgement; it must not invite duplicate mutation.
- Result-audit failure after an error/refusal returns only the fixed non-retry audit error.
- Access-frequency ranking consumes only exact `tool:minime_get_context`, never attempt verbs.
- Preserve the existing access-frequency implementation and positive exact-result behavior:
  attempts and non-release outcome rows are ignored naturally because their verb is not an
  exact released-result query, while an exact `tool:minime_get_context` result row continues
  to count under the legacy rule. Do not introduce an "actually released" filter or any other
  access-ranking redesign.
- The facade wraps every `Transport`, including in-memory and stdio; the private `McpServer` and its direct `connect()` are never returned or exported.
- JSON-RPC request IDs are `string | number`; numeric `0` is valid and must not be tested by truthiness.
- Per `(transport, requestId)` transitions are serialized and make exactly one terminal result-audit attempt.
- Duplicate in-flight IDs get their own attempt and `DUPLICATE_REQUEST_ID` result event, execute no second handler, receive no same-ID wire response, and close the transport.
- Cancellation/close after handler start cannot erase the handler's completion audit; response data and returned IDs are withheld as specified.
- Existing `tools/list` schemas, client actor, timezone behavior, tool/task/refusal semantics, normal wire payloads, and direct `invokeTool(tool, params, ctx)` source usage remain compatible.
- Use only public SDK 1.29.0 imports such as `@modelcontextprotocol/sdk/types.js` and `@modelcontextprotocol/sdk/shared/transport.js`; never import `dist/`, patch SDK internals, or rely on private fields.
- The installed `@modelcontextprotocol/sdk` 1.29.0 declaration is the binding access contract:
  `McpServer.server` is a `readonly` public property typed as `Server`, and
  `Server.getClientVersion()` is public.  The implementation may read that declaration through
  the lexical SDK instance solely for actor attribution; it must not read an underscored/private
  field, import a `dist/` module, use `any`/casts/reflection, or expose the instance through the
  facade.  Add a compile-time assertion for this exact public path before implementation.
- Do not change `package.json` or `bun.lock`; the live lock already resolves SDK 1.29.0.
- No database migration, transaction wrapper across handlers, new dependency, network call, or subsystem is introduced.
- Plain SQL remains only in `src/db/repo.ts`; all tests are offline and fictional.
- Pending metadata contains only transport identity, request ID, actor, canonical tool name, hashes, phase flags, and outcome flags—never parameters or content.
- Preserve `.env*`, `data/`, benchmarks, and all unrelated tracked/untracked files.
- Historical `DECISIONS.md` text is append-only.
- Two consecutive failed review/gate cycles stop the tranche for owner review.
- A `final_reviewer_sol` BLOCK is binding and cannot be waived.

---

## Upfront file and responsibility map

| Card | File | Action | Responsibility |
|---|---|---|---|
| 1 | `src/mcp/audit.ts` | Modify | Phase-specific event API, exact hashes/payloads, production sink |
| 1 | `src/mcp/tools/registry.ts` | Modify | Unaudited execute core, source-compatible direct two-phase invoke, fixed withholding |
| 1 | `src/mcp/audit-coordinator.ts` | Create | Request state, serialization, cancellation/close/duplicate/refusal/result ownership |
| 1 | `test/h4-audit-state.test.ts` | Create | Direct invoke and coordinator transition/failure tests |
| 2 | `src/mcp/audited-transport.ts` | Create | Universal public-`Transport` adapter and raw call metadata extraction |
| 2 | `src/mcp/server.ts` | Modify | Private `McpServer`, `extra.requestId` callback bridge, public facade only |
| 2 | `fixtures/mcp-tools-list-sdk-1.29.json` | Create before refactor | Canonical pre-H4 `tools/list` schema baseline |
| 2 | `test/h4-audit-transport.test.ts` | Create | InMemory/raw/PassThrough stdio, SDK refusal variants, actor/wire/race compatibility |
| 3 | `test/m2.tools.test.ts` | Modify | Exact attempt/result pairs through `buildServer().connect()` |
| 3 | `test/m6.leak.test.ts` | Modify | 200-call phase counts and phase-failure withholding/leak checks |
| 3 | `test/access-boost.test.ts` | Modify | Attempts and non-result outcomes never affect access ranking |
| 3 | `docs/GUIDE.md` | Modify | Owner-facing two-phase audit and fixed acknowledgement interpretation |
| 3 | `DECISIONS.md` | Modify | Append only H4's approved decision |
| 3 | `docs/SUBSYSTEMS.md` | Modify | Update only MCP door and Access-frequency boost rows |

## Exact public and internal interfaces

### Audit event API

`src/mcp/audit.ts` produces:

```ts
export type AuditOutcome =
  | "cancelled_before_execution"
  | "transport_closed_before_execution"
  | "completed_not_released"
  | "completed_after_disconnect";

export interface AuditSink {
  attempt(
    actor: string,
    tool: string,
    params: unknown,
    requestedNameHash?: string,
  ): Promise<string>; // resolves to params_hash only after the event is durable

  result(
    actor: string,
    tool: string,
    paramsHash: string,
    returnedIds: string[],
    returnedCount: number,
    error?: string,
    outcome?: AuditOutcome,
    requestedNameHash?: string,
  ): Promise<void>;
}

export function paramsHash(params: unknown): string;
export function requestedNameHash(rawName: unknown): string;
export const eventAuditSink: AuditSink;
```

Exact hash inputs:

```ts
paramsHash(params) =
  sha256(utf8(JSON.stringify(params ?? {}))).hex.slice(0, 16);

requestedNameHash(rawName) =
  sha256(utf8(JSON.stringify(rawName ?? null))).hex.slice(0, 16);
```

`AuditSink.attempt()` writes:

```json
{
  "params_hash": "0123456789abcdef",
  "requested_name_hash": "present only for tool:unknown"
}
```

`AuditSink.result()` writes:

```json
{
  "params_hash": "0123456789abcdef",
  "returned_ids": [],
  "returned_count": 0,
  "error": "optional fixed code",
  "outcome": "optional fixed outcome",
  "requested_name_hash": "present only for tool:unknown"
}
```

IDs are capped to the existing first 100 in `returned_ids`; `returned_count` is the uncapped
count. When `outcome` is present, the sink input and persisted payload are invariantly
`returned_ids: []` and `returned_count: 0`; only a normal result without a non-release outcome
may carry the uncapped redacted IDs/count. Neither method accepts a raw error/message.

The approved design's illustrative `AuditSink.result()` signature omits `returnedCount` in its
parameter list, but the same approved payload contract explicitly requires uncapped
`returned_count`. This plan's explicit `returnedCount` argument is the minimal faithful
implementation elaboration and is canonical for implementation; the >100 test below proves the
contract. This is not a spec deviation and requires no new `DECISIONS.md` entry.

### Tool execution and fixed wire results

`src/mcp/tools/registry.ts` keeps existing first-three-argument source compatibility and adds
an optional sink:

```ts
export type ToolResult =
  | { ok: true; envelope: Envelope }
  | {
      ok: false;
      error: { code: string; message: string; retry?: boolean };
    };

export async function executeTool(
  tool: ToolDef,
  params: unknown,
  ctx: ToolCtx,
): Promise<ToolResult>; // validates, executes, redacts; performs no audit

export async function invokeTool(
  tool: ToolDef,
  params: unknown,
  ctx: ToolCtx,
  auditSink?: AuditSink,
): Promise<ToolResult>; // attempt -> executeTool -> result/withhold

export interface AuditableToolResult {
  toolResult: ToolResult;
  callToolResult: CallToolResult;
  returnedIds: string[];
  returnedCount: number;
  error?: string;
}

export function toAuditableToolResult(
  result: ToolResult,
  timeZone?: string,
): AuditableToolResult;
```

The four exported fixed MCP `CallToolResult` constants in `registry.ts` and the
coordinator-local suppression value are:

```ts
export const ATTEMPT_FAILURE_RESULT = {
  isError: true,
  content: [{
    type: "text",
    text: '{"error":{"code":"INTERNAL","message":"Tool unavailable before execution.","retry":true}}',
  }],
} as const satisfies CallToolResult;

export const COMPLETED_RESULT_WITHHELD = {
  isError: false,
  content: [{
    type: "text",
    text: '{"data":{"status":"completed_result_withheld","retry":false},"sources":[],"gaps":["completion audit unavailable; result withheld"]}',
  }],
} as const satisfies CallToolResult;

export const AUDIT_UNAVAILABLE_RESULT = {
  isError: true,
  content: [{
    type: "text",
    text: '{"error":{"code":"AUDIT_UNAVAILABLE","message":"Tool result withheld because completion audit is unavailable.","retry":false}}',
  }],
} as const satisfies CallToolResult;

export const INTERNAL_EXECUTION_RESULT = {
  isError: true,
  content: [{
    type: "text",
    text: '{"error":{"code":"INTERNAL","message":"Internal tool error."}}',
  }],
} as const satisfies CallToolResult;

// Defined only inside audit-coordinator.ts; never exported as a client result.
const SUPPRESSED_CALL_RESULT = {
  isError: true,
  content: [],
} as const satisfies CallToolResult;
```

Direct `invokeTool()` maps these to:

```ts
attempt failure =>
  {ok:false,error:{code:"INTERNAL",message:"Tool unavailable before execution.",retry:true}}

successful execute + result failure =>
  {ok:true,envelope:{
    data:{status:"completed_result_withheld",retry:false},
    sources:[],
    gaps:["completion audit unavailable; result withheld"]
  }}

error execute + result failure =>
  {ok:false,error:{
    code:"AUDIT_UNAVAILABLE",
    message:"Tool result withheld because completion audit is unavailable.",
    retry:false
  }}
```

`executeTool()` catches `ToolError`, `z.ZodError`, and other errors exactly as current
`invokeTool()` does, but never calls an audit function. On success it extracts returned IDs
from the redacted envelope, not the raw handler envelope.

### Raw call metadata

Card 1's `src/mcp/audit-coordinator.ts` owns the transport-neutral metadata type so the state
machine compiles and is independently testable before Card 2:

```ts
export interface AuditedCallMeta {
  requestId: RequestId;
  actor: string;
  tool: string; // exact known name, otherwise "unknown"
  paramsForAudit: unknown;
  requestedNameHash?: string;
  refusalClass: "known" | "unknown" | "malformed" | "task";
}
```

Card 2's `src/mcp/audited-transport.ts` produces the raw extractor:

```ts
export type RawToolCallMeta = AuditedCallMeta;

export function rawToolCallMeta(
  message: JSONRPCMessage,
  actor: string,
  knownTools: ReadonlySet<string>,
): RawToolCallMeta | null;
```

It returns non-null only when all are true:

```text
message is a public-SDK JSONRPCRequest (valid string or numeric ID, including 0)
message.method === "tools/call"
```

Parameter selection is exact:

```ts
const params = isRecord(message.params) ? message.params : undefined;
const args = params?.arguments;
const argsAreValid = args === undefined || (isRecord(args) && !Array.isArray(args));
const paramsForAudit = argsAreValid ? (args ?? {}) : message.params;
```

Known name means `typeof params?.name === "string" && knownTools.has(params.name)`.
Every other name maps to `"unknown"` and gets
`requestedNameHash(params?.name ?? null)`.
Classification priority is exact: invalid params/name/arguments or an invalid task shape is
`"malformed"`; otherwise a known call with a valid task object (`ttl` absent or numeric) is
`"task"`; otherwise a schema-shaped unknown string name is `"unknown"`; all remaining known
calls are `"known"`.

Cancellation dispatch is pinned to the SDK 1.29 JSON-RPC notification shape. The adapter
intercepts only a JSON-RPC notification whose method is exactly `"notifications/cancelled"`
(no request ID) and whose `params` is a record with an own `requestId` property whose value is
a valid string or number, including numeric `0`. It calls `coordinator.cancel(requestId)`;
when `forwardNotification` is false it does not invoke the SDK `onmessage`, and when it is
true (for an unknown admitted ID) it forwards the unchanged notification once. A lookalike
method, a request carrying an ID, inherited `requestId`, missing `requestId`, array/non-record
params, or a non-string/non-number request ID is not coordinator-owned: it is forwarded
unchanged as a non-tool message and creates no attempt/result event. Tests must cover valid
ID `0`, known and unknown IDs, each malformed shape, and exact dispatch-versus-forward counts.

Task augmentation is read only from the top-level `message.params.task`; a nested
`arguments.task` is ordinary tool arguments and does not opt into task handling. A present
`task` is valid only when it is a non-array record and its own `ttl` is absent or a finite
JSON number. Classification checks the top-level params record first, then gives an invalid
top-level task shape precedence over invalid/missing name or invalid `arguments`, yielding
`refusalClass:"malformed"` and the fixed `BAD_INPUT` path. With a valid task object, a known
tool is `"task"` (unknown names remain `"unknown"`); without task augmentation, known and
unknown classification follows the ordinary name/arguments rules above. Tests pin absent
`ttl`, numeric `ttl`, string/null/array/non-record task values, malformed-task plus malformed
name/arguments precedence, and nested `arguments.task` non-augmentation.

### Coordinator types and transitions

`src/mcp/audit-coordinator.ts` imports public SDK types and produces:

```ts
import type {
  CallToolResult,
  JSONRPCMessage,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";

export type InboundDecision =
  | { action: "forward" }
  | { action: "respond"; result: CallToolResult }
  | { action: "drop"; closeTransport: boolean };

export type OutboundDecision =
  | { action: "send"; message: JSONRPCMessage }
  | { action: "drop" };

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
}

export class AuditCoordinator {
  constructor(auditSink: AuditSink, hooks?: CoordinatorHooks);

  receiveCall(meta: AuditedCallMeta): Promise<InboundDecision>;

  cancel(requestId: RequestId): Promise<{
    forwardNotification: boolean;
    closeTransport: boolean;
  }>;

  transportClosed(): Promise<void>;
  drain(): Promise<void>;

  handleCallback(
    requestId: RequestId,
    execute: () => Promise<CallbackResult>,
  ): Promise<CallToolResult>;

  handleOutbound(message: JSONRPCMessage): Promise<OutboundDecision>;

  claimOutbound(requestId: RequestId): Promise<"send" | "drop">;

  completeOutbound(requestId: RequestId): Promise<void>;

  pendingCount(): number; // metadata count only; used by tests and facade reconnect guard
}
```

Each pending entry is:

```ts
interface PendingCall {
  requestId: RequestId;
  actor: string;
  tool: string;
  paramsHash?: string;
  requestedNameHash?: string;
  refusalClass: AuditedCallMeta["refusalClass"];
  phase:
    | "attempt_pending"
    | "forwarded"
    | "running"
    | "result_auditing"
    | "result_audited";
  queuedOutcome?: "cancel" | "close";
  release: "pending" | "send" | "drop";
  terminalReplacement?: "audit_unavailable";
  terminalAuditStarted: boolean;
  chain: Promise<void>;
}
```

The coordinator uses `Map<RequestId, PendingCall>` directly; it never stringifies IDs, so
`0`, `"0"`, and other valid IDs remain distinct. `queue(entry, transition)` appends every
transition to `entry.chain`, captures rejection so a failed transition cannot poison later
cleanup, and ensures exactly one `terminalAuditStarted`.

Terminal transition table:

| Current phase | Input | Handler runs? | Result audit | Response |
|---|---|---:|---|---|
| `attempt_pending` | cancel | no | zero IDs, `cancelled_before_execution` after attempt | none |
| `attempt_pending` | close | no | zero IDs, `transport_closed_before_execution` after attempt | none |
| `forwarded` | cancel before callback wins queue | no | zero IDs, `cancelled_before_execution` | none |
| `forwarded` | close before callback wins queue | no | zero IDs, `transport_closed_before_execution` | none |
| `running` | cancel | yes, to completion | zero IDs, `completed_not_released` | dropped/suppressed |
| `running` | close | yes, to completion | zero IDs, `completed_after_disconnect` | dropped |
| `forwarded` + `refusalClass=task` | SDK refusal before callback | no | zero IDs, `SDK_REFUSAL` | unchanged after audit |
| `forwarded` + `refusalClass=task` | callback | no | zero IDs, `SDK_REFUSAL` | SDK's task refusal, after audit |
| `result_audited` | late cancel | already ran | existing IDs may remain | dropped/suppressed |
| any live phase | duplicate same ID | original only | duplicate attempt + `DUPLICATE_REQUEST_ID`; original follows close row | no duplicate response; close |

Attempt insertion happens after the entry is placed in `attempt_pending`; cancel/close sets
`queuedOutcome` synchronously before awaiting its queued transition. `receiveCall()` checks
that flag after attempt durability and cannot return `forward`.

`handleCallback()` sets `running` before invoking `execute`. A callback that loses to a
cancel/close terminal transition returns a private empty error result to the SDK without
calling `execute`; that value is exactly `SUPPRESSED_CALL_RESULT`, and the gateway/SDK
suppresses it so it is never sent. Handler completion
writes exactly one result event before returning to the SDK. Result-audit failure returns one
of the fixed withholding constants and marks the entry terminal so outbound handling cannot
audit again.

`handleCallback()` also catches every rejection from the complete execution/conversion
closure, including post-handler timezone localization, redaction serialization, BigInt,
circular, or injected conversion failures. It converts that rejection to
`INTERNAL_EXECUTION_RESULT`, zero returned IDs and `returnedCount:0`, and fixed audit error
`INTERNAL`; it never copies the thrown value. It then performs the same one result-audit
attempt, passing the callback's uncapped `returnedCount` alongside the first 100 IDs. Audit
failure returns `AUDIT_UNAVAILABLE_RESULT`. The entry cannot remain in `running`.

SDK 1.29 task augmentation has two distinct pre-execution paths. Production does not
advertise `tasks.requests.tools.call`, so the SDK normally refuses before the registered
callback and `handleOutbound()` writes the one `SDK_REFUSAL` result. If a task-capable SDK
server reaches the callback, `refusalClass === "task"` makes `handleCallback()` avoid
`running` and never call
`executeTool`; it writes the one result event with zero IDs and fixed error `SDK_REFUSAL`,
marks the entry `result_audited`, and returns `SUPPRESSED_CALL_RESULT`. The SDK's
post-callback `CreateTaskResult` validation then emits its native task refusal.
`handleOutbound()` sees the completed audit and releases that refusal unchanged. If the
task-refusal result audit failed, outbound handling replaces the SDK refusal with
`AUDIT_UNAVAILABLE_RESULT`. Neither path attempts a second result audit.
The failed task-audit path stores only
`terminalReplacement:"audit_unavailable"` through outbound claim—never an error object,
SDK text, or content—because SDK post-callback validation replaces the callback's return.

`handleOutbound()` owns result auditing only when an entry is still `forwarded`, meaning the
SDK refused before a registered callback. Fixed error mapping is:

```text
schema-shaped unknown string requested name               -> UNKNOWN_TOOL
non-string/missing requested name                         -> BAD_INPUT
known tool with missing/invalid tool arguments            -> BAD_INPUT
malformed raw arguments/params/name                       -> BAD_INPUT
task augmentation refused before callback or short-circuit -> SDK_REFUSAL
any other SDK-only refusal                                -> SDK_REFUSAL
```

It does not copy SDK text/error data into the event. If result audit fails, it replaces the
entire JSON-RPC response with a JSON-RPC success response whose `result` is
`AUDIT_UNAVAILABLE_RESULT`; no original refusal text is released:

```ts
{
  jsonrpc: "2.0",
  id: original.id,
  result: AUDIT_UNAVAILABLE_RESULT,
}
```

Callback completion and fallback refusal auditing leave the ID entry present through the
adapter's actual send/drop decision. Immediately before calling the inner transport,
`AuditedServerTransport.send()` calls serialized `claimOutbound(id)`; a cancel/close that
wins before that claim forces `"drop"`, while a notification after the claim is defined as
after send begins. The adapter calls
`completeOutbound(message.id)` in `finally` only after `inner.send()` settles, or immediately
after an intentional drop. Until then a late cancel/close can set `release="drop"` without a
second result audit. `completeOutbound()` removes content-bearing metadata and retains only
an ID tombstone through the current callback microtask; then it removes that too.
`pendingCount()` counts live entries and tombstones, so zero is asserted only after this
cleanup barrier.

### Audited transport and server facade

`src/mcp/audited-transport.ts` implements the SDK 1.29.0 public interface:

```ts
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";

export class AuditedServerTransport implements Transport {
  constructor(options: {
    inner: Transport;
    coordinator: AuditCoordinator;
    actor: () => string;
    knownTools: ReadonlySet<string>;
  });

  start(): Promise<void>;
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
  close(): Promise<void>;
  drain(): Promise<void>;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  get sessionId(): string | undefined;
  setProtocolVersion(version: string): void;
}
```

`start()` installs inner callbacks before `inner.start()`. Incoming non-tool messages pass
through unchanged. Incoming tool calls await `receiveCall()`; only `"forward"` invokes the
SDK-facing `onmessage`. Attempt failure sends the fixed response directly through `inner`
without exposing it to the SDK. Cancellation is intercepted only for the exact
`notifications/cancelled` notification shape defined above and detects presence with
`Object.hasOwn(params, "requestId")`, so request ID `0` is handled; a valid notification for
an unknown ID passes to the SDK unchanged. Malformed cancellation lookalikes and all other
non-tool messages are forwarded unchanged and never enter the coordinator.

Because public `Transport.onmessage` returns void, every async entry is launched as
`void track(processIncoming(message, extra))`; `track()` catches all rejection and owns the
promise until settlement. It never leaves an unhandled promise. An unexpected coordinator
or direct `inner.send()` rejection signals outward `onerror(new Error("audited MCP transport failure"))`
without raw error text, calls idempotent `transportClosed()` so any admitted pending call
attempts its fixed terminal result transition, and closes fail-closed. The same tracked drain
cleans all entries.
To avoid self-drain deadlock, the rejection handler records the fixed failure and schedules
the stored close promise only from `finally`, after removing that entry from the tracked set;
it never awaits `close()` from inside the promise being drained.

`inner.onerror` is also fail-closed, not merely forwarded. It emits only
`onerror(new Error("MCP transport protocol error"))`, schedules the same idempotent close,
and ensures `inner.close()` clears stdio's read buffer/listeners. Malformed JSON and
schema-invalid JSON-RPC lines never reach `rawToolCallMeta()`, so they write no attempt or
result event and can neither spin the SDK read loop nor leave the stream accepting later
calls.
Because stdio parse errors are raised inside a synchronous read loop, this error-close path
first installs the shared closing promise/flag and invokes `inner.close()` immediately; the
synchronous prefix clears the read buffer/listeners before control returns to the SDK loop.
It then awaits `coordinator.transportClosed()`, the already-started inner-close promise, and
the common drain. Normal explicit close retains the deliberate coordinator-mark then
inner-close order above. Inner `onclose` observes the already-installed shared state, so both
paths are idempotent and invoke outward `onclose` once.

`sessionId` reads `inner.sessionId`, and `setProtocolVersion()` delegates when the inner
transport implements it. `send()` calls `handleOutbound()` before `inner.send()`, claims the
serialized release decision after any late cancel/close, and always calls
`completeOutbound()` for a response ID. It forwards the original `TransportSendOptions` for
unchanged messages and uses `{relatedRequestId: message.id}` for a replacement response when
supported. It never mutates the caller's message object.
An error/notification with no valid string-or-number request ID bypasses claim/completion
entirely. An unchanged native refusal keeps both its original message and original
`TransportSendOptions`.

`src/mcp/server.ts` produces only:

```ts
export interface MinimeServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export interface BuildServerOptions {
  auditSink?: AuditSink;
  tools?: readonly ToolDef[];       // isolated test injection; defaults to ALL_TOOLS
  hooks?: CoordinatorHooks;        // isolated race barriers
}

export function buildServer(options?: BuildServerOptions): MinimeServer;
export async function startMcpServer(): Promise<MinimeServer>;
```

The `McpServer` instance, low-level `.server`, and direct `.connect()` remain lexical locals
inside `buildServer()`. Each admitted `connect()` constructs a fresh private `McpServer`,
registers the same tools, and pairs it with a fresh coordinator/adapter; no instance survives
a completed close. Production supplies no task capability and performs no experimental task
registration. `connect()` refuses an already-connected, closing, or still-pending prior
connection. `close()` is idempotent and uses this exact order:

```text
mark adapter closing; reject/close any new tool call
coordinator.transportClosed() marks queued/running outcomes
await inner transport close
await all tracked inbound/callback/send promises
await coordinator.drain() through result audit, outbound cleanup, and tombstone cleanup
invoke outward onclose once
clear private SDK/coordinator/adapter references; only now permit reconnect
```

Thus `await server.close()` cannot resolve while a `completed_after_disconnect` or other
terminal audit is pending. An abrupt inner `onclose` starts the same stored close promise;
although the public callback is void, later facade close/reconnect awaits that drain. The
callback signature is:

```ts
async (params: unknown, extra) => {
  return coordinator.handleCallback(extra.requestId, async () => {
    // handleCallback short-circuits refusalClass="task" before this closure runs.
    const result = await executeTool(tool, params, {
      // `sdkServer` is the lexical private McpServer instance.  Its public
      // readonly `server: Server` declaration is the only SDK access used here.
      actor: `agent:${sdkServer.server.getClientVersion()?.name ?? "unknown"}`,
    });
    // executeTool already parsed/validated time_zone after attempt admission. Re-read only
    // after success so localization uses the same value and cannot throw.
    const timeZone = result.ok ? timeZoneFromParams(params) : undefined;
    const auditable = toAuditableToolResult(result, timeZone);
    return {
      callToolResult: auditable.callToolResult,
      returnedIds: auditable.returnedIds,
      returnedCount: auditable.returnedCount,
      ok: result.ok,
      error: auditable.error,
    };
  });
}
```

The actor closure is evaluated at raw receipt and again only for callback context; after
normal initialization both are the same client name. The attempt's stored actor is used for
both events, preventing actor drift during close/reconnect.

## Card 1: Audit state machine and direct invocation

**Files:**
- Modify: `src/mcp/audit.ts`
- Modify: `src/mcp/tools/registry.ts`
- Create: `src/mcp/audit-coordinator.ts`
- Create: `test/h4-audit-state.test.ts`

**Interfaces:**
- Consumes: current `logEvent()`, `redactDeep()`, `ToolDef`, SDK public JSON-RPC/CallToolResult types
- Produces: `AuditSink`, `eventAuditSink`, `executeTool()`, compatible `invokeTool()`, fixed results, `AuditCoordinator`

- [ ] **Step 1: Write failing direct two-phase audit tests**

Use a fictional custom `ToolDef`, a temporary filesystem sentinel, and a recording sink:

```ts
class RecordingSink implements AuditSink {
  events: Array<{phase:"attempt"|"result"; tool:string; ids?:string[]; count?:number; error?:string; outcome?:AuditOutcome}> = [];
  fail: "attempt" | "result" | null = null;
  attemptGate?: Promise<void>;

  async attempt(actor: string, tool: string, params: unknown, nameHash?: string) {
    await this.attemptGate;
    if (this.fail === "attempt") throw new Error("injected");
    const hash = paramsHash(params);
    this.events.push({phase:"attempt", tool});
    return hash;
  }

  async result(
    actor: string,
    tool: string,
    hash: string,
    ids: string[],
    returnedCount: number,
    error?: string,
    outcome?: AuditOutcome,
  ) {
    if (this.fail === "result") throw new Error("injected");
    if (outcome) {
      expect(ids).toEqual([]);
      expect(returnedCount).toBe(0);
    }
    this.events.push({phase:"result", tool, ids, count:returnedCount, error, outcome});
  }
}
```

Add a normal-success fixture whose redacted envelope contains 137 source IDs. Assert the
recorded result has `returned_count:137` while `returned_ids` contains exactly the first 100
IDs. Add a separate non-release outcome fixture with the same internal 137 IDs and assert the
sink receives/persists `returned_ids:[]` and `returned_count:0`. This proves the count is
uncapped without redesigning `accessCounts`, while all non-release outcomes remain ignored
because their IDs/count are empty (not because they use a different verb).

Assert:

```text
attempt failure -> counter 0, filesystem sentinel absent, only fixed retry=true error
attempt event resolves before counter increments
success result failure -> fixed completed_result_withheld only; sentinel/source/title absent
handler error result failure -> fixed AUDIT_UNAVAILABLE only; raw error absent
normal success -> attempt then result; result IDs equal redacted envelope source IDs
bad timezone -> attempt then BAD_INPUT result; handler counter 0
execution/conversion closure rejects -> fixed INTERNAL result + one INTERNAL audit; pending cleans
execution/conversion closure rejects and result audit fails -> fixed AUDIT_UNAVAILABLE; pending cleans
```

- [ ] **Step 2: Write failing coordinator transition tests**

Drive `receiveCall()`, `cancel()`, `handleCallback()`, `handleOutbound()`, and
`transportClosed()` directly with barriers. Include numeric request ID `0`. Assert every row
in the transition table, `pendingCount() === 0` after terminal cleanup, and one terminal
result attempt even when result insertion itself rejects.
For every transition carrying a non-release outcome, assert the recorded result has empty IDs
and `returned_count:0`; a normal success keeps its positive redacted IDs/count.
For `refusalClass:"task"`, pass an execution closure that would mutate a sentinel; assert the
closure is never invoked, one `SDK_REFUSAL` result is written, and the later outbound SDK
error is released/replaced without a second result call.

Add independent two-ID coverage: pause ID `"slow"` attempt, complete ID `"fast"` through
attempt/result, then release `"slow"`; each ID keeps attempt-before-result while the slow
audit does not block the fast call.

- [ ] **Step 3: Run Card 1 tests to prove red**

Run:

```bash
bun test test/h4-audit-state.test.ts
```

Expected: FAIL because `AuditSink`, `executeTool()`, fixed withholding results, and
`AuditCoordinator` do not exist; current `invokeTool()` executes before audit and swallows
result-audit failure.

- [ ] **Step 4: Split `executeTool()` from direct `invokeTool()`**

Move only timezone/schema validation, handler execution, redaction, and structured error
conversion into `executeTool()`. Implement `invokeTool()` as:

```ts
const sink = auditSink ?? eventAuditSink;
let hash: string;
try {
  hash = await sink.attempt(ctx.actor, tool.name, params);
} catch {
  return {ok:false,error:{
    code:"INTERNAL",
    message:"Tool unavailable before execution.",
    retry:true,
  }};
}

const result = await executeTool(tool, params, ctx);
const allIds = result.ok ? result.envelope.sources.map((source) => source.id) : [];
const ids = allIds.slice(0, 100);
const returnedCount = allIds.length;
const error = result.ok ? undefined : result.error.code;
try {
  await sink.result(ctx.actor, tool.name, hash, ids, returnedCount, error);
  return result;
} catch {
  return result.ok
    ? {ok:true,envelope:{
        data:{status:"completed_result_withheld",retry:false},
        sources:[],
        gaps:["completion audit unavailable; result withheld"],
      }}
    : {ok:false,error:{
        code:"AUDIT_UNAVAILABLE",
        message:"Tool result withheld because completion audit is unavailable.",
        retry:false,
      }};
}
```

- [ ] **Step 5: Implement the phase event API**

Implement the exact payloads and verbs. `attempt()` must return its hash only after
`logEvent()` resolves. `result()` never catches `logEvent()`; callers own withholding. The
database-backed `eventAuditSink`, coordinator, direct `invokeTool()`, and test
`RecordingSink` all carry an explicit uncapped `returnedCount` argument; they persist
`returned_count` independently from the first-100 `returned_ids`. For every non-release
outcome they pass/persist both an empty ID list and zero count. Do not infer count from the
capped list at any sink boundary.
Remove the old single-phase `auditToolCall()` export after `rg -n "auditToolCall" src test`
shows no caller; retaining a post-handler convenience path would recreate the bypass.

- [ ] **Step 6: Implement and test the coordinator**

Implement the exact interfaces, state table, queue discipline, refusal mapping, fixed result
replacement, and duplicate path. Use a one-terminal-attempt guard checked inside every
serialized terminal transition. A duplicate performs its own sink calls without inserting a
second map entry:

```ts
const hash = await sink.attempt(meta.actor, meta.tool, meta.paramsForAudit, meta.requestedNameHash);
await sink.result(
  meta.actor,
  meta.tool,
  hash,
  [],
  0,
  "DUPLICATE_REQUEST_ID",
  undefined,
  meta.requestedNameHash,
);
return {action:"drop", closeTransport:true};
```

If the duplicate attempt/result audit fails, still execute no handler, emit no second same-ID
response, and close.

- [ ] **Step 7: Run direct/coordinator and existing direct-call tests**

Run:

```bash
bun test \
  test/h4-audit-state.test.ts \
  test/privacy-hardening.test.ts \
  test/m5.decisions.test.ts \
  test/m6.leak.test.ts \
  test/m8.agenda.test.ts \
  test/m9.state-tz.test.ts \
  test/decision-digest.test.ts
```

Expected: all pass; existing three-argument `invokeTool()` imports require no call-site edit.

- [ ] **Step 8: Commit Card 1**

```bash
git add src/mcp/audit.ts src/mcp/tools/registry.ts src/mcp/audit-coordinator.ts test/h4-audit-state.test.ts
git commit -m "fix(audit): record attempts before direct execution"
```

## Card 2: Universal private transport facade and coordinator bridge

**Files:**
- Create: `fixtures/mcp-tools-list-sdk-1.29.json`
- Create: `src/mcp/audited-transport.ts`
- Modify: `src/mcp/server.ts`
- Create: `test/h4-audit-transport.test.ts`
- Test: `test/m2.tools.test.ts`

**Interfaces:**
- Consumes: Card 1 coordinator/fixed results, SDK 1.29.0 public `Transport`, `RequestId`, JSON-RPC, `CallToolResult`
- Produces: `AuditedServerTransport`, facade-only `MinimeServer`, callback correlation through `extra.requestId`

- [ ] **Step 1: Capture the pre-refactor tools/list baseline**

Before editing `src/mcp/server.ts`, create a fresh OS temporary capture directory outside the
repository and all untracked owner directories. The capture is scratch only; the final fixture
is an intentional tracked source artifact created later with `apply_patch` from the reviewed
capture contents. Never use `Bun.write`, `cp`, `mv`, or a shell redirection to create or update
the repository fixture. Capture, inspect, and cleanup all happen in one Bun `try/finally`: the
capture is inspected while it still exists, then `rmSync(..., {recursive:true, force:true})`
runs and an `existsSync` postcondition makes cleanup failure fatal:

```bash
bun -e '
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./src/mcp/server.ts";
const repoRoot = realpathSync(resolve("."));
const captureDir = realpathSync(mkdtempSync(join(tmpdir(), "minime-h4-tools-list-")));
if (captureDir === repoRoot || captureDir.startsWith(`${repoRoot}/`)) {
  throw new Error("capture directory is not external");
}
const capturePath = join(captureDir, "mcp-tools-list-sdk-1.29.json");
try {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(st);
  const client = new Client({name:"schema-capture",version:"1.0.0"});
  await client.connect(ct);
  const listed = await client.listTools();
  await Bun.write(capturePath, JSON.stringify(listed.tools, null, 2) + "\n");
  const inspected = JSON.parse(readFileSync(capturePath, "utf8"));
  if (!Array.isArray(inspected) || inspected.length !== 13) {
    throw new Error("tools/list capture is not the expected public 13-tool schema");
  }
  if (JSON.stringify(inspected).match(/runtime|actor|credential|sentinel/i)) {
    throw new Error("tools/list capture contains non-public runtime data");
  }
  await client.close();
  await server.close();
} finally {
  try {
    rmSync(captureDir, {recursive:true, force:true});
  } catch {
    throw new Error("tools/list capture cleanup failed");
  }
  if (existsSync(captureDir)) throw new Error("tools/list capture cleanup failed");
}
'
```

Expected: exit 0 and a deterministic JSON array for all 13 current tool definitions. The Bun
block inspects the external capture before its `finally`; stop if it contains runtime data,
actor names, or anything other than public tool metadata/schema. After review, create/update the declared tracked
`fixtures/mcp-tools-list-sdk-1.29.json` with `apply_patch` only, then assert that no capture,
temporary, or ledger file remains under the repository and that the staged diff contains only
the intended fixture/code paths.

The capture check is a required red/green assertion: after the Bun process exits, scan the
repository working tree for `minime-h4-tools-list-*`, temporary JSON, or ledger files and fail
if any exists; compare the staged path list and allow only the declared fixture/code paths.
This proves the external capture was removed rather than merely trusting the `finally` body.

- [ ] **Step 2: Write failing facade/schema/refusal tests**

In `test/h4-audit-transport.test.ts`, connect only through `buildServer().connect()` and
assert:

```ts
expect(await client.listTools()).toEqual({
  tools: JSON.parse(await Bun.file(fixture).text()),
});
expect("server" in buildServer()).toBe(false);
```

Before the transport tests, add this declaration-only access check (it must compile against
the locked SDK and must not import a private implementation path):

```ts
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server as PublicSdkServer } from "@modelcontextprotocol/sdk/server/index.js";

const sdkServer = new SdkMcpServer({ name: "h4-contract", version: "1.0.0" });
const publicServer: PublicSdkServer = sdkServer.server;
expect(typeof publicServer.getClientVersion).toBe("function");
void publicServer.getClientVersion();
// @ts-expect-error private/underscored SDK implementation fields are forbidden
void publicServer._server;
```

The assertion is compile-time plus a harmless public-method smoke check: no `as any`, type
cast, `dist/` import, reflection, or facade escape hatch may be added to make it pass.  The
production callback uses the same public declaration through its lexical `sdkServer` only;
the returned `MinimeServer` exposes `connect`/`close` and nothing SDK-specific.

Drive raw in-memory requests for these SDK paths:

```text
known tool + malformed arguments array        -> attempt + BAD_INPUT result
known tool + missing required field           -> attempt + BAD_INPUT result
known tool + invalid timezone                 -> attempt + BAD_INPUT result
unknown string name                           -> unknown attempt/result + exact name hash
non-string/missing name                       -> unknown attempt/result + hash(JSON.stringify(null/value))
known tool + task augmentation refusal        -> attempt + SDK_REFUSAL result
known tool + top-level task `{}`               -> task classification; no handler before SDK refusal
known tool + top-level task `{ttl: 30}`        -> task classification; no handler before SDK refusal
known tool + malformed task plus bad name/args -> malformed classification/BAD_INPUT precedence
known tool + nested `arguments.task`           -> ordinary known classification (not task)
handler returns conversion-hostile data       -> attempt + INTERNAL result, exactly once
```

Assert raw input/name/sentinel appears in neither event verb nor payload.
Use two real SDK 1.29 task tests. The production `buildServer()` fixture advertises no task
capability: prove the SDK fallback refusal occurs before callback, the handler/callback
counter stays zero, and one `SDK_REFUSAL` result is audited. Separately, create a test-only
real
`new McpServer(info, {capabilities:{tasks:{requests:{tools:{call:{}}}}}})` behind the same
`AuditedServerTransport`/coordinator and prove the callback short-circuit executes no handler,
writes one `SDK_REFUSAL`, and preserves the SDK refusal wire shape. Never add or advertise
that capability in production.
In the task-capable failing-sink variant, assert only the durable attempt exists, no result
row is claimed, all native SDK validation text is absent from the fixed replacement, and
pending/tombstone counts reach zero.
The conversion case also traverses the real transport with a fictional BigInt/circular or
injected localization result, proves no SDK-generated unaudited error escapes, and asserts
one terminal audit plus `pendingCount() === 0` after outbound cleanup.

Add a raw cancellation matrix using public SDK JSON-RPC messages: exact
`notifications/cancelled` with own `params.requestId: 0` and a string ID dispatches to the
coordinator; a valid unknown ID forwards once; a lookalike method, request-with-ID, inherited
`requestId`, missing `requestId`, array/non-record params, and boolean/object request IDs each
forward unchanged with zero coordinator/audit calls. Assert exact `onmessage` dispatch counts,
no attempt/result rows for malformed notifications, and no response bytes for a coordinator-
owned cancellation.

- [ ] **Step 3: Write failing cancellation/close/duplicate transport tests**

Use `BuildServerOptions.tools` with one fictional barrier tool. Through raw
`InMemoryTransport`, cover:

```text
cancel ID 0 while attempt is paused
cancel after forward barrier but before callback-start barrier
cancel after handler mutation but before handler return
close after handler mutation but before return
await facade close while handler/result audit is gated -> close stays pending, then drains and permits reconnect
concurrent duplicate ID while original is unstarted
concurrent duplicate ID while original is running
request-ID reuse after terminal cleanup
```

Capture raw response IDs. Assert the duplicate produces no second response with that ID,
executes at most the original, writes its own duplicate attempt/refusal, closes the transport,
and leaves the original correctly terminal-audited.
Inject a coordinator rejection and a direct `inner.send()` rejection independently. Assert
one fixed `onerror`, no unhandled rejection, fail-closed transport close, terminal audit
attempt for any admitted call, zero leaked raw error/sentinel, and drained pending state.

- [ ] **Step 4: Write failing PassThrough stdio coverage**

Construct:

```ts
const stdin = new PassThrough();
const stdout = new PassThrough();
const transport = new StdioServerTransport(stdin, stdout);
const server = buildServer({auditSink});
await server.connect(transport);
stdin.write(serializeMessage(rawCall));
```

Read stdout with public `ReadBuffer`, and prove a normal call and an SDK refusal each receive
no bytes before their result-audit barrier resolves. Also prove attempt failure returns only
`ATTEMPT_FAILURE_RESULT` and the handler/filesystem sentinel remains untouched.

Against a real `StdioServerTransport`, separately write one malformed-JSON line and one
JSON-valid/schema-invalid line. Bound each test with a short race timeout, assert one
sanitized protocol error, zero tool events, close/drain completion without a busy loop, and
that a subsequent valid call on the same streams receives no execution or response because
the transport is closed.

- [ ] **Step 5: Run Card 2 tests to prove red**

Run:

```bash
bun test test/h4-audit-transport.test.ts
```

Expected: FAIL because `buildServer()` exposes `McpServer`, raw invalid calls bypass the
callback audit, cancellation ID 0 is not coordinator-owned, and no audited transport exists.

- [ ] **Step 6: Implement raw metadata extraction and the transport adapter**

Use only:

```ts
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
```

Implement `rawToolCallMeta()` and every adapter callback/method exactly as specified. Preserve
`extra` when forwarding incoming messages and preserve send options for outgoing messages.
On protocol-error duplicate, call the inner transport's `close()` only after both duplicate
audit phase calls settle.

- [ ] **Step 7: Make the SDK server private and bridge `extra.requestId`**

Build/register tools exactly as before, but close over the active coordinator and use the
callback's second argument. The only returned object implements `MinimeServer`. Do not expose
an escape hatch, raw server getter, alternate connect function, or unwrapped test server.

The facade tracks one active audited transport and one stored close/drain promise.
`connect()` refuses if active/closing or if the prior coordinator still has pending calls;
after the stored drain settles it may create a fresh private SDK server. `close()` is
idempotent and every caller awaits that same complete drain.
`startMcpServer()` connects a public `StdioServerTransport` through the same facade and keeps
the existing readiness stderr line.

- [ ] **Step 8: Implement no-duplicate outbound ownership**

When callback completion already attempted result audit, mark the entry so
`AuditedServerTransport.send()` only releases/replaces/drops it. When no callback began,
`handleOutbound()` performs the one fallback result audit. Keep a short-lived ID-only
terminal tombstone until the callback microtask/outbound decision settles so a late
SDK-suppressed response cannot be mistaken for a new refusal; it contains no actor, tool,
hash, parameter, or content.

- [ ] **Step 9: Run transport, schema, and M2 tests**

Run:

```bash
bun test test/h4-audit-state.test.ts test/h4-audit-transport.test.ts test/m2.tools.test.ts
```

Expected: all tests pass; fixture equality is exact; both in-memory and stdio paths have one
attempt/result pair; no raw server is reachable.

- [ ] **Step 10: Commit Card 2**

```bash
git add \
  fixtures/mcp-tools-list-sdk-1.29.json \
  src/mcp/audited-transport.ts \
  src/mcp/server.ts \
  test/h4-audit-transport.test.ts
git commit -m "fix(mcp): audit raw calls through transport facade"
```

## Card 3: Regression, leak, access, documentation, and final gate

**Files:**
- Modify: `test/m2.tools.test.ts`
- Modify: `test/m6.leak.test.ts`
- Modify: `test/access-boost.test.ts`
- Modify: `test/h4-audit-transport.test.ts`
- Modify: `docs/GUIDE.md`
- Modify: `DECISIONS.md`
- Modify: `docs/SUBSYSTEMS.md`

**Interfaces:**
- Consumes: Cards 1–2 complete facade and audit event contract
- Produces: full compatibility/leak/access evidence, H4 decision/inventory documentation, binding-reviewed branch

- [ ] **Step 1: Tighten M2 to exact phase pairs**

For each client call, query by actor and assert exactly:

```text
tool:minime_state:attempt
tool:minime_state
```

and:

```text
attempt payload keys = params_hash only
result payload keeps returned_ids and returned_count
attempt ID < result ID
```

Update the two-call count assertion from 2 to 4. The same existing `buildServer().connect()`
setup is retained, proving the production facade rather than direct registry calls.

- [ ] **Step 2: Extend the 200-call leak suite**

Count tool phase events for `agent:fuzzer` before/after. For each intentional normal direct
call, assert one attempt and one result; for injected attempt failure assert no handler result
and no mutation; for injected result failure assert only fixed withholding payloads.

Across all returned text and event payloads, retain the existing tier-0/tier-2 sentinels and
add fictional parameter/title/source/error sentinels. Assert none appear. Do not weaken any
existing SQL-injection, RLS, unlock-expiry, or 200-call assertions.

- [ ] **Step 3: Prove access ranking ignores non-result phases**

Insert the positive legacy exact-result event and each non-release outcome using the same
actor/id fixture:

```ts
await logEvent({
  actor: ACTOR,
  verb: "tool:minime_get_context:attempt",
  payload: {params_hash:"0".repeat(16)},
});
await logEvent({
  actor: ACTOR,
  verb: "tool:minime_get_context",
  payload: {
    params_hash:"1".repeat(16),
    returned_ids:[id],
    returned_count:1,
  },
});
await logEvent({
  actor: ACTOR,
  verb: "tool:minime_get_context",
  payload: {
    params_hash:"0".repeat(16),
    returned_ids:[],
    returned_count:0,
    outcome:"completed_not_released",
  },
});
```

Repeat the outcome row for `cancelled_before_execution`, `transport_closed_before_execution`,
and `completed_after_disconnect`, asserting each has exactly empty `returned_ids` and zero
`returned_count`. Assert the positive exact-result row preserves legacy `accessCounts([id],
90)` behavior while attempts and all non-release outcome rows do not change that count. Keep
the existing positive exact-result-verb test green; do not add a release-state filter or
otherwise redesign access ranking.

- [ ] **Step 4: Add final raw wire/refusal assertions**

For every fixed result, parse text and compare exact object and `isError`. Assert:

```text
attempt failure retry = true
completed_result_withheld retry = false and sources = []
AUDIT_UNAVAILABLE retry = false
every non-release outcome audit payload has returned_ids = [] and returned_count = 0
no original data/source ID/title/path/actor/error text survives replacement
no response bytes appear before result audit
```

For a late cancellation after a normal result event becomes durable but before SDK send,
accept IDs in the audit row while requiring response suppression; document this conservative
over-report, never under-report rule in the test name.

- [ ] **Step 5: Run all H4 regressions**

Run:

```bash
bun test \
  test/h4-audit-state.test.ts \
  test/h4-audit-transport.test.ts \
  test/m2.tools.test.ts \
  test/m6.leak.test.ts \
  test/access-boost.test.ts \
  test/privacy-hardening.test.ts \
  test/m9.state-tz.test.ts
```

Expected: all pass; 200 calls leak no locked content; every nonfailed call has one durable
attempt/result; access ranking preserves the legacy exact-result behavior and ignores attempt
verbs plus non-release outcome rows.

- [ ] **Step 6: Append the H4 decision and update only owned inventory rows**

Append this heading to `DECISIONS.md`:

```markdown
## 2026-07-23 — H4: raw-receipt attempt and pre-release result auditing
```

Its bullets state:

```text
Context: post-handler audit allowed mutation without a durable row and retry-unsafe INTERNAL.
Decision: raw tools/call attempt, callback/fallback result audit, universal facade transport, fixed withholding acknowledgements, and serialized cancellation/close/duplicate ownership.
Why: make audit intent durable before effects and disclosure durable before release without claiming a distributed transaction.
Validation: direct, InMemory, PassThrough stdio, SDK refusal, ID-0 cancellation, duplicate-ID, leak, schema, and access tests plus full branch gate.
Approved by: docs/superpowers/specs/2026-07-23-pre-w5-hardening-design.md.
```

Update only:

- `MCP door`: add `src/mcp/audit-coordinator.ts` and `src/mcp/audited-transport.ts`, H4 tests,
  and the new decision heading.
- `Access-frequency boost`: preserve the legacy rule that only the exact
  `tool:minime_get_context` result verb counts; attempts and result rows carrying a
  non-release outcome are ignored naturally, and cite the H4 access regression/new decision.

No new subsystem row is added: the coordinator/adapter replace unsafe MCP audit plumbing
inside the existing MCP door.

- [ ] **Step 7: Document owner/client interpretation**

In `docs/GUIDE.md`, explain:

```text
tool:<name>:attempt = durable receipt, not proof of execution
tool:<name> = terminal result/error/outcome
attempt without result = process interruption/incomplete call
completed_result_withheld = handler completed; do not retry automatically
AUDIT_UNAVAILABLE = error/refusal result withheld; do not retry automatically
attempt-phase INTERNAL retry=true = handler did not begin
```

Do not promise crash recovery or cross-resource rollback.

- [ ] **Step 8: Commit Card 3**

```bash
git add \
  test/m2.tools.test.ts \
  test/m6.leak.test.ts \
  test/access-boost.test.ts \
  test/h4-audit-transport.test.ts \
  docs/GUIDE.md \
  DECISIONS.md \
  docs/SUBSYSTEMS.md
git commit -m "test(audit): lock transport and leak invariants"
```

- [ ] **Step 9: Prove dependency/protected-path/file scope**

Run:

```bash
test -n "${WORKTREE_PATH:?set the pinned H4 worktree path}"
test -n "${START_SHA:?recorded when the H4 worktree was created}"
git -C "$WORKTREE_PATH" diff --name-only "$START_SHA"...HEAD
git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD -- \
  package.json bun.lock db/migrations scripts/repairs .env data
git -C "$WORKTREE_PATH" status --short
(
  cd "$WORKTREE_PATH"
  bun -e 'import pkg from "./node_modules/@modelcontextprotocol/sdk/package.json"; console.log(pkg.version)'
)
```

Expected: only the upfront-map implementation files changed; protected/dependency diff prints
nothing; SDK prints `1.29.0`; no unrelated tracked edit exists.

- [ ] **Step 10: Run the complete branch gate**

```bash
bun test
bunx tsc --noEmit
bunx biome check .
git diff --check
make check-subsystems
make verify
```

Expected: every command exits 0, Biome performs no fix, no test is newly skipped, all offline
MinimeBench floors remain green.

- [ ] **Step 11: Assemble acceptance evidence**

Record:

```text
branch: codex/hardening-audit-attempt
starting H1 merge SHA
three focused commit SHAs
Card 1/2 red commands and pre-fix failures
focused green test counts
SDK locked version 1.29.0
tools/list fixture equality
ID-0/cancel/close/duplicate result-audit counts
200-call leak counts
full gate exit codes
dependency/protected-path proof
DECISIONS.md heading
MCP door and Access-frequency row diffs
```

- [ ] **Step 12: Obtain independent reviews and enforce stop conditions**

Create a fresh review scratch directory outside `WORKTREE_PATH` and the repository (for
example `${TMPDIR:-/tmp}/minime-h4-review-<pid>`), remove it in `finally`, and generate the
review input with `git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD -- <upfront-map-paths>`.
Do not include untracked owner files or scratch paths in the diff. Send that final diff/evidence
first to `first_pass_reviewer_luna`; resolve every
Critical/Important finding. A disputed Luna Critical may be closed only by a fresh
`critical_adjudicator_sol`. Then send the final branch head to a fresh
`final_reviewer_sol`.

Expected: no unresolved Luna Critical/Important finding and explicit binding Sol `PASS`.

Stop for the owner instead of merging if the SDK public 1.29 interfaces differ from those
pinned here, raw `tools/call` receipt cannot be observed through a universal public
`Transport`, any handler can execute without coordinator admission, same-ID duplicate
responses cannot be prevented, normal data can escape before result durability, a migration
or dependency change becomes necessary, a protected/unrelated file must change, a second
consecutive gate/review cycle fails, or binding Sol returns `BLOCK`.
