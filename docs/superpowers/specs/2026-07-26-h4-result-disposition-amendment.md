# H4 Result Authorization and Transport Disposition Amendment

**Status:** Owner-approved normative amendment
**Approved baseline:** `a71bbf4847079a702596380e4ae8477fcbfcbce0`
**Date:** 2026-07-26

## Purpose

H4 originally required one append-only `tool:<name>` result event to serve simultaneously as
the pre-release authorization, the final cancellation/disconnect outcome, and the access-
frequency disclosure signal. Binding review proved that combination unsound: JavaScript must
select and submit an immutable event payload before asynchronous PostgreSQL durability, so a
cancellation or close can be observed after submission but before durability. Moving a
callback closer to submission only renames that interval; append-only history prevents the
submitted row from being rewritten.

This amendment separates two facts:

1. `tool:<name>` is a durable result authorization written before any call to the underlying
   transport's `send()`;
2. `tool:<name>:disposition` records the local transport outcome correlated to that durable
   result event.

This is an amendment inside the existing MCP-door and access-frequency subsystems. It adds no
delivery/outbox subsystem and makes no peer-acknowledgement claim.

## Superseded H4 claims

The historical hardening design, H4 implementation plan, and prior decision entries remain
unchanged as append-only history. This document supersedes only these H4 claims:

- a transport call has exactly one terminal result event;
- `tool:<name>` alone proves that a response was released;
- cancellation after result payload selection may count as an access because selection is a
  durability boundary;
- `accessCounts()` may count an exact result row without correlated release evidence;
- historical or direct uncorrelated result rows remain eligible access signals;
- H4 requires no migration;
- every successful transport call has exactly two tool audit events.

All other approved H4 requirements remain in force, including durable attempt before
execution, fixed audit-failure acknowledgements, raw-name privacy, exact SDK/public transport
boundaries, no content-bearing pending metadata, and append-only `events`.

## Normative local guarantee

For a transport-originated result authorization `R`:

1. `R` is durable and its lossless PostgreSQL `events.id::text` is known before the audited
   adapter invokes `inner.send()`.
2. The coordinator makes at most one irreversible transition from `preclaim` to
   `release_claimed`.
3. The transition to `release_claimed` is synchronous and immediately precedes invocation of
   `inner.send()`, with no intervening `await`.
4. If cancellation, close, SDK suppression, duplicate handling, or another terminal drop wins
   before `release_claimed`, `inner.send()` is never invoked and the disposition status is
   `suppressed`.
5. After `release_claimed`, the disposition can never be `suppressed`.
6. If `inner.send()` fulfills, the disposition status is `released`.
7. If `inner.send()` is invoked and throws synchronously, rejects, is interrupted, or may have
   partially written, the disposition status is `send_uncertain`.
8. In an uninterrupted process, exactly one disposition append is attempted for every durable
   transport result authorization.
9. At most one disposition for a result event may become durable.
10. A missing disposition means incomplete/unknown.

`released` proves only that the local SDK `Transport.send()` promise fulfilled. It does not
prove peer receipt, framing, parsing, client handling, application use, or user observation.
No result/disposition sequence is atomic with process crash, streams, sockets, or a remote
client. A transactional outbox and peer acknowledgement are out of scope.

Fixed audit-failure responses are outside this guarantee when no confirmed durable result
event ID exists to correlate.

## Event and API contract

### Audit types

`src/mcp/audit.ts` defines:

```ts
export type AuditDelivery = "transport" | "direct";

export interface ResultAuditRecord {
  returnedIds: string[];
  returnedCount: number;
  error?: string;
  delivery: AuditDelivery;
}

export interface DurableResultAudit {
  eventId: string;
}

export type AuditDisposition =
  | { status: "suppressed"; outcome?: AuditOutcome }
  | { status: "released" }
  | { status: "send_uncertain" };

export interface AuditSink {
  attempt(
    actor: string,
    tool: string,
    params: unknown,
    requestedNameHash?: string,
  ): Promise<string>;

  result(
    actor: string,
    tool: string,
    paramsHash: string,
    record: ResultAuditRecord,
    requestedNameHash?: string,
  ): Promise<DurableResultAudit>;

  disposition(
    actor: string,
    tool: string,
    resultEventId: string,
    disposition: AuditDisposition,
  ): Promise<void>;
}
```

`FinalizeResultAudit`, `resultAtCommit`, and the coordinator's
`resultAuditLinearized` state are removed. No callback immediately before insert submission is
described as a commit or durability boundary.

### Lossless event identity

`src/db/repo.ts::logEvent()` returns `Promise<string>` from:

```sql
returning id::text as id
```

The event ID never passes through a JavaScript `number`. Existing callers may await and ignore
the returned string.

### Attempt event

Attempt payload remains content-free:

```text
verb: tool:<name>:attempt
payload:
{
  "params_hash": "0123456789abcdef",
  "requested_name_hash": "optional"
}
```

### Result authorization

Transport result:

```text
verb: tool:<name>
payload:
{
  "params_hash": "0123456789abcdef",
  "returned_ids": ["at most 100 redacted source IDs"],
  "returned_count": 137,
  "error": "optional fixed code",
  "requested_name_hash": "optional",
  "delivery": "transport"
}
```

Direct `invokeTool()` result:

```text
verb: tool:<name>
payload:
{
  "params_hash": "0123456789abcdef",
  "returned_ids": ["at most 100 redacted source IDs"],
  "returned_count": 137,
  "error": "optional fixed code",
  "delivery": "direct"
}
```

An already-observed non-release signal still causes the authorization to carry empty IDs and
zero count when the payload has not yet been submitted. A signal observed while the insert is
pending cannot rewrite that submitted payload; the correlated disposition is authoritative.

### Disposition

Released:

```text
verb: tool:<name>:disposition
payload:
{
  "result_event_id": "9223372036854775807",
  "status": "released"
}
```

Suppressed:

```text
verb: tool:<name>:disposition
payload:
{
  "result_event_id": "9223372036854775807",
  "status": "suppressed",
  "returned_ids": [],
  "returned_count": 0,
  "outcome": "optional approved cancellation/disconnect outcome"
}
```

Send uncertain:

```text
verb: tool:<name>:disposition
payload:
{
  "result_event_id": "9223372036854775807",
  "status": "send_uncertain"
}
```

Disposition rows contain no response IDs, raw parameters, response content, SDK error text,
titles, paths, or copied actor. Their actor column and canonical tool verb match the result.

## Database enforcement

Migration `020_audit_disposition.sql` adds:

```sql
create unique index events_tool_disposition_result_event_uidx
  on events ((payload->>'result_event_id'))
  where verb like 'tool:%:disposition'
    and payload ? 'result_event_id';

create index events_get_context_released_disposition_idx
  on events ((payload->>'result_event_id'))
  where verb = 'tool:minime_get_context:disposition'
    and payload->>'status' = 'released';
```

The in-process coordinator also sets `dispositionAttempted` synchronously before awaiting the
append. It never retries a failed or unknown disposition insert and never uses
`ON CONFLICT DO NOTHING`. A uniqueness violation is an audit failure, not idempotent success.

## Access-frequency amendment

Only a `delivery:"transport"` exact `tool:minime_get_context` result joined to a correlated
`released` disposition is eligible:

```sql
select r.payload->'returned_ids'->>0 as id, count(*)::int as n
from events r
join events d
  on d.verb = 'tool:minime_get_context:disposition'
 and d.payload->>'result_event_id' = r.id::text
 and d.payload->>'status' = 'released'
where r.verb = 'tool:minime_get_context'
  and r.payload->>'delivery' = 'transport'
  and r.at >= $since
  and actor filtering
  and r.payload->'returned_ids'->>0 = any($ids)
group by 1
```

Historical rows lacking `delivery:"transport"`, direct results, missing dispositions,
`suppressed`, and `send_uncertain` do not count. This intentionally resets the rolling access
signal after upgrade. The ±0.05 boost and all search weights remain unchanged.

## Transport state machine

Each pending coordinator entry carries:

```ts
resultEventId?: string;
deliveryState:
  | "no_result"
  | "result_pending"
  | "preclaim"
  | "release_claimed"
  | "disposed";
dispositionAttempted: boolean;
```

The transitions are:

| Input | Required transition |
|---|---|
| handler/refusal produces candidate | `no_result -> result_pending`; start authorization insert |
| cancel/close before submission | record first terminal signal; authorization gets zero IDs/count |
| cancel/close while insert pending | record first terminal signal and drop ownership; do not mutate submitted payload |
| authorization fails or is unknown | withhold original result; use existing fixed acknowledgement/refusal behavior |
| authorization succeeds with terminal signal | `result_pending -> preclaim`; append `suppressed`; never send |
| authorization succeeds without terminal signal | `result_pending -> preclaim`; expose response to SDK adapter |
| cancel/close/SDK drop in `preclaim` | append `suppressed`; never send |
| outbound claim wins | synchronously `preclaim -> release_claimed`; immediately invoke send |
| send fulfills | append `released` |
| send throws/rejects/is interrupted | append `send_uncertain` |
| disposition attempt settles | `-> disposed`; retire matching generation |

Cancellation or close after `release_claimed` may drive teardown but cannot change the
disposition to `suppressed`.

The first observed preclaim terminal signal remains authoritative:

```text
cancel then close -> cancellation outcome
close then cancel -> disconnect outcome
```

It is recorded synchronously before either caller awaits serialized cleanup.

## Complete path requirements

| Path | Result authorization | Send | Disposition |
|---|---|---:|---|
| normal success | redacted IDs, transport | invoked | released or send_uncertain |
| handler error | zero IDs, fixed error, transport | invoked for error response | released or send_uncertain |
| unknown/malformed/timezone refusal | zero IDs, fixed audit error, transport | SDK response path | local send outcome |
| task refusal before callback | zero IDs, SDK_REFUSAL, transport | SDK response path | local send outcome |
| task-capable callback short-circuit | zero IDs, SDK_REFUSAL, transport | SDK response path | local send outcome |
| cancel/close before callback | zero IDs, transport | never | suppressed with outcome |
| cancel/close while running/result pending | candidate may already contain IDs | never | suppressed with outcome |
| cancel/close after authorization, before claim | existing authorization | never | suppressed |
| cancel/close after claim | existing authorization | invoked | released or send_uncertain |
| SDK produces no outbound before drain | existing authorization | never | suppressed |
| duplicate in-flight ID | duplicate result has DUPLICATE_REQUEST_ID | no duplicate response | duplicate suppressed, then close |
| attempt failure | no confirmed attempt/result | fixed retryable control response | none |
| result failure after success | no confirmed result ID | completed_result_withheld | none |
| result failure after error/refusal | no confirmed result ID | AUDIT_UNAVAILABLE | none |
| direct invokeTool | direct result durable before return | no transport | none |

## Failure and crash interpretation

| Point | Durable interpretation |
|---|---|
| no attempt | call not durably admitted |
| attempt only | incomplete attempted call |
| result insert rejects but may have committed | possible uncorrelated result; no access count |
| result without disposition before claim | authorization durable; delivery unknown |
| result without disposition after claim/send | delivery unknown |
| released disposition | only local send fulfillment proven |
| send_uncertain disposition | send invoked; partial or complete local write possible |
| suppressed disposition failure | send not invoked; audit incomplete |
| released/uncertain disposition failure | bytes may have left; audit incomplete; never retry or fabricate |

Disposition failure after send cannot change wire content. It emits only the existing
sanitized transport error and drives identity-safe close/drain.

## Direct invocation

`invokeTool(tool, params, ctx, auditSink?)` remains source-compatible:

1. attempt audit before execution;
2. execute and redact;
3. durable `delivery:"direct"` result before return;
4. existing completed-result-withheld or AUDIT_UNAVAILABLE mapping on result failure;
5. no transport disposition;
6. no access-frequency contribution.

## Identity-owned facade lifecycle

`buildServer()` owns one record:

```ts
type OwnerState = "connecting" | "open" | "closing" | "closed";

interface ConnectionOwner {
  generation: symbol;
  state: OwnerState;
  sdkServer: McpServer;
  adapter: AuditedServerTransport;
  coordinator: AuditCoordinator;
  teardown?: Promise<void>;
}
```

`beginTeardown(target)`:

1. returns `target.teardown` if already installed;
2. installs a deferred teardown promise and sets `state:"closing"` before calling close or
   awaiting;
3. starts `adapter.close()` first so its synchronous prefix rejects inbound work;
4. closes the private SDK server through the same owner;
5. awaits adapter close, tracked work, coordinator drain, and SDK close;
6. sets `closed`;
7. clears the facade owner only when `owner === target`;
8. resolves or rejects the installed promise once.

Adapter `onclose`, connect failure, explicit close, and close-during-connect all reuse this
promise. A late callback from owner A can never clear owner B.

After `sdkServer.connect(adapter)` resolves, `connect()` succeeds only if the same owner is
still `connecting`; if teardown began while connect was pending, it awaits teardown and
rejects with a fixed lifecycle error. A new connection is refused while any owner remains
installed.

## Test isolation and gates

The normal Bun preload forces tests onto `minime_test`. The approved correction adds an
explicit `MINIME_SCRATCH_TEST_DATABASE_URL` escape only when:

- host is loopback;
- database name matches `minime_h4_disposition_[a-z0-9_]+`;
- database is neither `minime` nor `minime_test`;
- query and fragment are empty.

Invalid values fail before importing the database client.

The restricted gate is limited to H4 state/transport tests plus TypeScript, changed-file
Biome, diff, subsystem, dependency, and path checks. Database-backed migration/access/M2/M6
tests run sequentially only against one disposable guarded database and delete it
unconditionally.

Canonical `bun test`, `make verify`, and reset of `minime` or `minime_test` are not authorized
for this correction.

## Stop conditions

Stop if any implementation:

- treats payload selection/submission as durability;
- describes `released` as peer receipt or use;
- allows post-claim cancellation to become suppressed;
- maps an invoked failing send to suppressed instead of send_uncertain;
- retries an unknown disposition append;
- lets direct or uncorrelated results feed access counts;
- passes result IDs through a JavaScript number;
- stores raw parameters, response content, SDK errors, titles, or paths in pending/disposition
  metadata;
- installs facade teardown after a close operation or await;
- lets connect resolve after its owner entered teardown;
- lets a stale owner clear a successor;
- needs another migration, dependency, fixture, SDK-private import, subsystem, or tracked path;
- cannot prove disposable database isolation;
- receives an unresolved Luna Critical/Important finding or binding Sol BLOCK.
