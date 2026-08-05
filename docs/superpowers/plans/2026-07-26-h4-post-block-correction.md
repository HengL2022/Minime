# H4 Result Disposition and Facade Lifecycle Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace H4's unsound single-row disclosure claim with durable result authorization plus an exact local transport disposition, and make the MCP facade lifecycle identity-safe across connect failure, close reentrancy, and late callbacks.

**Architecture:** A `tool:<name>` result authorization returns its lossless PostgreSQL event ID before the adapter may invoke `Transport.send`; one correlated disposition records suppressed, locally released, or send-uncertain. A single connection-owner record installs teardown before any close/await and clears facade state only by identity. Direct `invokeTool()` remains two-phase and never contributes to transport access counts.

**Tech Stack:** Bun/TypeScript, PostgreSQL 16 append-only `events`, postgres.js 3.4.9, `@modelcontextprotocol/sdk` 1.29.0 public `Transport`, Zod 3.25.76, Bun test, Biome.

## Global Constraints

- Work only in `<ABS_REPO_PATH>/.claude/worktrees/hardening-audit-attempt`.
- Treat `a71bbf4847079a702596380e4ae8477fcbfcbce0` as the frozen implementation
  diff baseline; do not require it to be the current HEAD.
- Require normative commit `5209b24669187e2f30e74d0f31378c93f55ad26f` as an ancestor
  of the clean implementation starting HEAD. The documentation-only preflight correction
  commit may sit above it. Before Task 1 run
  `git merge-base --is-ancestor 5209b24669187e2f30e74d0f31378c93f55ad26f HEAD`
  and stop if it fails.
- Implement tasks strictly in order. Each task gets its own RED, GREEN, focused commit, fresh first-pass Luna review, and binding Sol review before the next task begins.
- Preserve I2 one door, I3 tiered egress, I7 honest envelopes, and I8 append-only audit.
- `tool:<name>` is a durable pre-send authorization, not proof of client delivery.
- Disposition statuses are exactly `suppressed`, `released`, and `send_uncertain`.
- `released` means only that local `Transport.send()` fulfilled; never claim peer receipt, parsing, handling, use, or crash atomicity.
- Once `release_claimed` is set, the disposition can never become `suppressed`.
- One uninterrupted coordinator entry attempts exactly one disposition append; the database permits at most one durable disposition per result event.
- A missing disposition means incomplete/unknown.
- Result-event IDs are obtained with PostgreSQL `id::text` and remain strings end-to-end.
- Historical/direct/unlinked results do not contribute to `accessCounts`; the ±0.05 boost and all search weights stay unchanged.
- Direct `invokeTool()` remains source-compatible, writes `delivery:"direct"`, has no transport disposition, and never contributes to transport access counts.
- No raw parameters, response content, SDK error text, returned IDs, titles, paths, or copied actor enter disposition or pending metadata. The suppressed payload contains only the required empty list, zero count, and optional fixed outcome.
- Historical H4 specs, plans, and `DECISIONS.md` entries are append-only and are not edited.
- Do not modify `package.json`, `bun.lock`, existing migrations, tool-schema fixture, raw metadata classification, `.env*`, `data/`, `db-dump/`, repairs, backups, or unrelated files.
- Do not use SDK-private imports, add dependencies, introduce an outbox/peer-ack subsystem, or alter normal tool schemas/wire envelopes.
- Do not run canonical `bun test`, `make verify`, or any reset of `minime` or `minime_test`.
- Database-backed tests run only through the guarded disposable `MINIME_SCRATCH_TEST_DATABASE_URL` path, sequentially, with unconditional database deletion.
- Every full or filtered `test/m6.leak.test.ts` command carries
  `MINIME_SCRATCH_TEST_DATABASE_URL="$H4_DB_URL"` explicitly. Do not broaden
  `testDatabaseUrl()`'s ordinary runtime fallback or accept a generic test URL as isolation.
- Two consecutive failed implementation/review cycles stop for the owner.
- Any binding Sol BLOCK is final for that cycle.

---

## Authorized implementation map

| Task | Paths | Responsibility |
|---|---|---|
| 1 | `src/db/repo.ts`, `src/mcp/audit.ts`, `db/migrations/020_audit_disposition.sql`, `test/access-boost.test.ts`, `test/m1.schema.test.ts`, `test/setup.ts` | lossless event identity, audit API/persistence, disposition indexes, released-only access projection, disposable DB guard |
| 2 | `src/mcp/audit-coordinator.ts`, `src/mcp/audited-transport.ts`, `test/h4-audit-state.test.ts`, `test/h4-audit-transport.test.ts` | result/disposition state machine, release claim, send outcome, cancellation/close/duplicate/refusal ownership |
| 3 | `src/mcp/server.ts`, `test/h4-audit-transport.test.ts` | identity-owned connecting/open/closing/closed facade lifecycle |
| 4 | `src/mcp/audit.ts`, `src/mcp/audit-coordinator.ts`, `src/mcp/tools/registry.ts`, `test/h4-audit-state.test.ts`, `test/h4-audit-transport.test.ts`, `test/m2.tools.test.ts`, `test/m6.leak.test.ts` | remove the temporary typed bridge, leave the exact final audit interface, direct-call compatibility, and transport integration/leak phase expectations |

No implementation task may add another tracked path.

## Shared interfaces

Task 1 introduces the final result/disposition shapes plus a strictly typed compatibility
bridge. The bridge exists only so untouched legacy callers remain TypeScript-green through
Tasks 1–3. In Task 2 the coordinator consumes only `DispositionAuditSink`, while both H4
recording sinks implement `TransitionalAuditSink` because the same sink instances also pass
through unchanged `BuildServerOptions.auditSink: AuditSink` and
`invokeTool(..., auditSink: AuditSink)` entry points. Task 4 owns every remaining bridge
caller and type-import site, removes the bridge from production and test sinks, and leaves
the exact final `AuditSink` interface shown after the transitional block.

Task 1 transitional types:

```ts
export interface LegacyResultAuditRecord {
  returnedIds: string[];
  returnedCount: number;
  error?: string;
  outcome?: AuditOutcome;
}

export type FinalizeResultAudit = () => LegacyResultAuditRecord;

export interface LegacyAuditSink {
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
    returnedIds: string[],
    returnedCount: number,
    error?: string,
    outcome?: AuditOutcome,
    requestedNameHash?: string,
  ): Promise<unknown>;
  resultAtCommit(
    actor: string,
    tool: string,
    paramsHash: string,
    finalize: FinalizeResultAudit,
    requestedNameHash?: string,
  ): Promise<unknown>;
}

export interface DispositionAuditSink {
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

// Existing untouched callers keep compiling against this name until Task 4.
export type AuditSink = LegacyAuditSink;
export type TransitionalAuditSink = LegacyAuditSink & DispositionAuditSink;
```

`eventAuditSink` is explicitly typed `TransitionalAuditSink`. Its named, overloaded
`result()` implementation accepts exactly the legacy positional tuple or the new record
tuple; it does not use `any`, a cast, or an optional catch-all signature. The legacy branch
persists the existing unlinked payload without a `delivery` claim, while the record branch
persists the new exact payload and returns its durable event ID. Thus no transitional direct
or duplicate row is falsely classified as transport delivery.

Task 4 deletes `LegacyResultAuditRecord`, `FinalizeResultAudit`, `LegacyAuditSink`,
`DispositionAuditSink`, `TransitionalAuditSink`, the positional overload, and
`resultAtCommit`. The final declaration is exactly:

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

Task 2 produces:

```ts
export type OutboundClaim =
  | { action: "send"; generation: symbol }
  | {
      action: "drop";
      generation: symbol;
      outcome?: AuditOutcome;
    }
  | { action: "untracked" };

completeOutbound(
  requestId: RequestId,
  generation: symbol,
  disposition: AuditDisposition,
): Promise<void>;
```

Task 3 preserves the public facade:

```ts
export interface MinimeServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}
```

### Task 1: Audit Persistence, Repository Projection, Migration, and Scratch Guard

**Files:**
- Modify: `src/db/repo.ts`
- Modify: `src/mcp/audit.ts`
- Create: `db/migrations/020_audit_disposition.sql`
- Modify: `test/access-boost.test.ts`
- Modify: `test/m1.schema.test.ts`
- Modify: `test/setup.ts`

**Interfaces:**
- Consumes: existing `events` table, `logEvent()`, `accessCounts()`, `AuditOutcome`
- Produces: lossless `logEvent(): Promise<string>`, the final result/disposition shapes plus
  the strictly typed transitional bridge above, production
  `eventAuditSink: TransitionalAuditSink`, migration-enforced disposition
  uniqueness/indexing, released-only access projection, guarded disposable DB selection

- [ ] **Step 1: Add the guarded scratch-database selector**

In `test/setup.ts`, preserve the ordinary forced `minime_test` behavior and add:

```ts
const SCRATCH_DB = /^\/minime_h4_disposition_[a-z0-9_]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function scratchTestDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("MINIME_SCRATCH_TEST_DATABASE_URL must use loopback");
  }
  if (!SCRATCH_DB.test(url.pathname)) {
    throw new Error(
      "MINIME_SCRATCH_TEST_DATABASE_URL database must match minime_h4_disposition_*",
    );
  }
  if (url.pathname === "/minime" || url.pathname === "/minime_test") {
    throw new Error("refusing owner or shared test database");
  }
  if (url.search || url.hash) {
    throw new Error("scratch database URL must not contain query or fragment");
  }
  return url.toString();
}

export function testDatabaseUrl(
  source = process.env.MINIME_TEST_DATABASE_URL ?? process.env.DATABASE_URL,
): string {
  const isolated = process.env.MINIME_SCRATCH_TEST_DATABASE_URL;
  if (isolated) return scratchTestDatabaseUrl(isolated);
  if (source) {
    const url = new URL(source);
    url.pathname = "/minime_test";
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  return "postgres://minime:minime@localhost:5432/minime_test";
}
```

The scratch branch must run before the ordinary pathname rewrite. Do not accept a generic
`MINIME_TEST_DATABASE_URL` as an isolated override.

- [ ] **Step 2: Add scratch-guard assertions**

In `test/m1.schema.test.ts`, add table-driven calls to `testDatabaseUrl()` with temporarily
patched `MINIME_SCRATCH_TEST_DATABASE_URL`. Assert:

```text
postgres://minime:minime@127.0.0.1:5432/minime_h4_disposition_gate -> preserved
.../minime -> rejected
.../minime_test -> rejected
.../other_scratch -> rejected
remote.example/.../minime_h4_disposition_gate -> rejected
.../minime_h4_disposition_gate?sslmode=require -> rejected
.../minime_h4_disposition_gate#fragment -> rejected
```

Restore the prior environment value in `finally`.

- [ ] **Step 3: Create a disposable database for Task 1 RED/GREEN**

Run exactly:

```bash
H4_DB_NAME="minime_h4_disposition_$$"
H4_ADMIN_URL="postgres://minime:minime@127.0.0.1:${MINIME_PG_PORT:-5432}/postgres"
H4_DB_URL="postgres://minime:minime@127.0.0.1:${MINIME_PG_PORT:-5432}/${H4_DB_NAME}"
createdb --maintenance-db="$H4_ADMIN_URL" --owner=minime "$H4_DB_NAME"
trap 'dropdb --if-exists --maintenance-db="$H4_ADMIN_URL" "$H4_DB_NAME"' EXIT
```

Before any test, prove:

```bash
test "$H4_DB_NAME" != "minime"
test "$H4_DB_NAME" != "minime_test"
case "$H4_DB_NAME" in minime_h4_disposition_*) ;; *) exit 1 ;; esac
```

Stop if creation or any guard fails. Run Steps 3–11 in the same shell session so the trap
remains active for every early exit.

- [ ] **Step 4: Write failing audit persistence and migration tests**

In `test/m1.schema.test.ts`, add tests that:

```text
logEvent returns a decimal string, never a number
the returned string equals the inserted events.id::text
a result event ID larger than Number.MAX_SAFE_INTEGER remains byte-identical as text
one tool disposition for a result_event_id inserts successfully
a second tool disposition with the same result_event_id rejects on
  events_tool_disposition_result_event_uidx
the released get_context disposition index exists with the exact predicate
UPDATE/DELETE/TRUNCATE on events remain rejected
```

Use test-only sequence advancement inside the disposable database to obtain a value above
`9007199254740991`; do not coerce the value to a JS number.

- [ ] **Step 5: Write failing released-only access tests**

Replace the old positive legacy-row assertion in `test/access-boost.test.ts` with fictional
fixtures covering:

```text
historical exact result lacking delivery -> no count
delivery:"direct" exact result -> no count
delivery:"transport" with no disposition -> no count
transport result + suppressed disposition -> no count
transport result + send_uncertain disposition -> no count
transport result + released disposition -> count 1
attempt and disposition verbs never contribute their own IDs
only returned_ids[0] on the correlated result counts
actor and time-window filters remain unchanged
```

Insert the result first, capture `id::text`, then insert the disposition whose
`result_event_id` is that exact string.

- [ ] **Step 6: Run Task 1 RED**

Run sequentially against the disposable database:

```bash
MINIME_SCRATCH_TEST_DATABASE_URL="$H4_DB_URL" bun test test/m1.schema.test.ts
MINIME_SCRATCH_TEST_DATABASE_URL="$H4_DB_URL" bun test test/access-boost.test.ts
```

Expected: FAIL because `logEvent()` returns void, migration 020 and disposition indexes do
not exist, event IDs are not exposed, and `accessCounts()` still counts uncorrelated exact
result rows.

- [ ] **Step 7: Implement lossless logEvent and the audit API**

In `src/db/repo.ts`, change `logEvent()` to:

```ts
export async function logEvent(e: {
  actor: string;
  verb: string;
  entityType?: string;
  entityId?: string;
  payload?: unknown;
}): Promise<string> {
  const [row] = await sql`
    insert into events (at, actor, verb, entity_type, entity_id, payload)
    values (${now()}, ${e.actor}, ${e.verb}, ${e.entityType ?? null}, ${e.entityId ?? null},
            ${sql.json((e.payload as any) ?? {})})
    returning id::text as id`;
  if (!row || typeof row.id !== "string") throw new Error("event insert returned no id");
  return row.id;
}
```

In `src/mcp/audit.ts`, add the final shapes and the transitional types from **Shared
interfaces**. Keep the exported name `AuditSink` aliased to `LegacyAuditSink` in Task 1 so
the untouched coordinator, registry, and recording sinks remain TypeScript-green.

Define a named overloaded production function with only these two public signatures:

```ts
async function compatibleResult(
  actor: string,
  tool: string,
  paramsHash: string,
  record: ResultAuditRecord,
  requestedNameHash?: string,
): Promise<DurableResultAudit>;

async function compatibleResult(
  actor: string,
  tool: string,
  paramsHash: string,
  returnedIds: string[],
  returnedCount: number,
  error?: string,
  outcome?: AuditOutcome,
  requestedNameHash?: string,
): Promise<DurableResultAudit>;
```

The implementation parameter is `recordOrIds: ResultAuditRecord | string[]`; discriminate
with `Array.isArray(recordOrIds)`. Do not add a third public overload, `any`, or a cast.
The positional branch calls a private `persistLegacyResult()` that preserves the pre-H4
payload exactly and omits `delivery`. The record branch calls the new persistence path
below. Both private paths return `{ eventId }` from the lossless `logEvent()` string, though
legacy callers ignore the value.

`eventAuditSink.result()` record branch:

```ts
const eventId = await logEvent({
  actor,
  verb: `tool:${tool}`,
  payload: {
    params_hash: paramsHashValue,
    returned_ids: record.returnedIds.slice(0, 100),
    returned_count: record.returnedCount,
    ...(record.error ? { error: record.error } : {}),
    ...(requestedNameHashValue ? { requested_name_hash: requestedNameHashValue } : {}),
    delivery: record.delivery,
  },
});
return { eventId };
```

`eventAuditSink.disposition()` writes:

```ts
await logEvent({
  actor,
  verb: `tool:${tool}:disposition`,
  payload:
    disposition.status === "suppressed"
      ? {
          result_event_id: resultEventId,
          status: "suppressed",
          returned_ids: [],
          returned_count: 0,
          ...(disposition.outcome ? { outcome: disposition.outcome } : {}),
        }
      : {
          result_event_id: resultEventId,
          status: disposition.status,
        },
});
```

Keep the old `resultAtCommit()` implementation only as part of the compatibility bridge. It
must call `persistLegacyResult()` and must not add `delivery` or disposition. Do not remove
`FinalizeResultAudit` or `resultAtCommit` in Task 1: untouched
`test/m6.leak.test.ts` still imports/implements them. Task 2 removes all coordinator and H4
recording-sink uses; Task 4 removes the final direct-test import and deletes the bridge.

- [ ] **Step 8: Add migration 020**

Create `db/migrations/020_audit_disposition.sql` with exactly:

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

Do not add a table, mutable staging row, foreign key, retry table, or outbox.

- [ ] **Step 9: Implement released-only accessCounts**

Replace only the event query in `accessCounts()` with:

```ts
const rows = await sql`
  select r.payload->'returned_ids'->>0 as id, count(*)::int as n
  from events r
  join events d
    on d.verb = 'tool:minime_get_context:disposition'
   and d.payload->>'result_event_id' = r.id::text
   and d.payload->>'status' = 'released'
  where r.verb = 'tool:minime_get_context'
    and r.payload->>'delivery' = 'transport'
    and r.at >= ${since}
    and (${!actor} or r.actor = ${actor ?? ""})
    and r.payload->'returned_ids'->>0 = any(${ids})
  group by 1`;
```

Do not grandfather uncorrelated rows and do not change boost weights.

- [ ] **Step 10: Run Task 1 GREEN and static gates**

Run sequentially:

```bash
MINIME_SCRATCH_TEST_DATABASE_URL="$H4_DB_URL" bun test test/m1.schema.test.ts
MINIME_SCRATCH_TEST_DATABASE_URL="$H4_DB_URL" bun test test/access-boost.test.ts
bunx tsc --noEmit
bunx biome check \
  src/db/repo.ts src/mcp/audit.ts \
  test/access-boost.test.ts test/m1.schema.test.ts test/setup.ts
git diff --check
```

Expected: both focused suites pass; the returned event ID stays text; duplicate disposition
is rejected; only released transport results count; static gates are clean. In particular,
`bunx tsc --noEmit` proves the still-untouched coordinator, registry, and recording sinks
compile against the strictly typed bridge.

- [ ] **Step 11: Drop the disposable database and prove cleanup**

Run:

```bash
dropdb --if-exists --maintenance-db="$H4_ADMIN_URL" "$H4_DB_NAME"
trap - EXIT
if psql "$H4_ADMIN_URL" -Atqc \
  "select 1 from pg_database where datname = '$H4_DB_NAME'" | grep -q 1; then
  exit 1
fi
```

Stop if the database remains.

- [ ] **Step 12: Commit Task 1 and obtain reviews**

```bash
git add \
  src/db/repo.ts \
  src/mcp/audit.ts \
  db/migrations/020_audit_disposition.sql \
  test/access-boost.test.ts \
  test/m1.schema.test.ts \
  test/setup.ts
git commit -m "fix(audit): persist result dispositions"
```

Require exact six-path scope, fresh Luna with no Critical/Important, and binding Sol PASS
before Task 2.

### Task 2: Coordinator and Audited Transport State Machine

**Files:**
- Modify: `src/mcp/audit-coordinator.ts`
- Modify: `src/mcp/audited-transport.ts`
- Modify: `test/h4-audit-state.test.ts`
- Modify: `test/h4-audit-transport.test.ts`

**Interfaces:**
- Consumes: Task 1 `DispositionAuditSink.result(): Promise<DurableResultAudit>`,
  `DispositionAuditSink.disposition()`, `AuditDisposition`
- Produces: one irreversible release claim, one disposition attempt, generation-safe outbound completion, exact local send semantics across callbacks, refusals, cancellations, closes, duplicates, and task paths

- [ ] **Step 1: Replace recording-sink gates with post-submission and disposition gates**

In both H4 test sinks, replace `implements AuditSink` with
`implements TransitionalAuditSink`. Keep the temporary `FinalizeResultAudit` import and
`resultAtCommit()` because these sink instances must remain assignable to unchanged
`BuildServerOptions.auditSink: AuditSink` and `invokeTool(..., auditSink: AuditSink)` until
Task 4. Add:

```ts
resultSubmitted?: (actor: string, tool: string, record: ResultAuditRecord) => void;
resultDurableGate?: Promise<void>;
dispositionStarted?: (disposition: AuditDisposition) => void;
dispositionGate?: Promise<void>;
dispositionAttempts = 0;
```

Implement `result()` with exactly the same two overloads as Task 1
`compatibleResult()`: record-form returning `Promise<DurableResultAudit>` and the legacy
positional form returning `Promise<DurableResultAudit>`. The private implementation accepts
`recordOrIds: ResultAuditRecord | string[]` and uses `Array.isArray`, without `any` or casts.
For the positional branch, build the test-only legacy record with `delivery: "direct"`; for
the record branch, preserve its explicit delivery. Then call
`resultSubmitted(actor, tool, record)`, await `resultDurableGate`, record the authorization,
and return a deterministic,
monotonically assigned decimal-string event ID.

Mechanically migrate every existing H4 test use of `resultGate` to `resultDurableGate` and
`resultStarted` to `resultSubmitted`; callbacks that need only zero, one, or two leading
arguments may ignore the remaining arguments. No stale gate name remains.

Keep a temporary, strictly typed `resultAtCommit()` matching `LegacyAuditSink`. It awaits the
same gate, calls the finalizer once, records its legacy outcome, and returns a deterministic
`{ eventId }`; Task 2 production code must never invoke it after Step 9. Implement
`disposition()` exactly as `DispositionAuditSink`: increment `dispositionAttempts`
synchronously, signal, await its gate, then record. Task 4 removes the overload,
`resultAtCommit()`, and all legacy imports from both H4 sinks.

- [ ] **Step 2: Write post-submission cancellation and close RED tests**

Add direct coordinator tests:

```text
running handler returns secret ID
result() captures/submits the normal transport record
cancel arrives before resultDurableGate resolves
result becomes durable
callback remains suppressed
one disposition attempt is suppressed/completed_not_released
claim never reaches send
pending reaches zero after completion
```

Repeat for close with `completed_after_disconnect`.

Expected baseline symptom: `resultAuditLinearized` treats both signals as late, leaves normal
IDs/no outcome, and provides no disposition API.

- [ ] **Step 3: Write first-terminal-winner RED**

Use two cases:

```text
cancel then close while result pending -> completed_not_released
close then cancel while result pending -> completed_after_disconnect
```

Begin both public operations before releasing the result gate; do not await either first.

- [ ] **Step 4: Write release-claim and send-outcome RED tests**

Through the real audited adapter:

```text
cancel before claim -> inner.send call count 0; suppressed
close before claim -> inner.send call count 0; suppressed
inner.send fulfills -> released
inner.send throws synchronously -> send_uncertain
inner.send returns rejected promise -> send_uncertain
inner.send invokes a cancellation callback then rejects -> send_uncertain, never suppressed
```

Assert `dispositionAttempts === 1` in every durable-result case. A transport whose send method
is entered has crossed the irreversible claim even if it throws before returning a promise.
For each synchronous/rejected send failure also assert:

```text
adapter.send rejects with exactly "audited MCP transport failure"
adapter.onerror observes exactly one sanitized "audited MCP transport failure"
inner close begins exactly once through the idempotent close path
raw inner error text is absent from rejection, onerror, audit events, and disposition payload
send_uncertain disposition is attempted before adapter.send rejects
coordinator pending reaches zero after adapter.close/drain
```

- [ ] **Step 5: Write disposition-failure and drain RED tests**

Cover:

```text
suppressed disposition failure -> no send, no retry, sanitized error/close, pending zero
released disposition failure -> send already fulfilled, no wire replacement, sanitized close
send_uncertain disposition failure -> no retry, sanitized close
held disposition gate -> adapter drain and reconnect stay pending
missing disposition is not represented as released
```

For each disposition failure assert the public `adapter.send` promise rejects with the fixed
sanitized failure when it still owns that send path, `onerror` fires at most once, close is
scheduled, the raw audit failure is absent, and no second disposition append is attempted.

Add exact no-result fixed-response tests:

```text
successful handler + result audit failure -> COMPLETED_RESULT_WITHHELD,
  pending/no_result correlation, claimNoResultOutbound send, inner send fulfills,
  completeNoResultOutbound retires matching generation, dispositionAttempts 0
handler error + result audit failure -> AUDIT_UNAVAILABLE_RESULT with the same owned
  no-result send/completion behavior and dispositionAttempts 0
SDK fallback refusal + result audit failure -> raw SDK text replaced by
  AUDIT_UNAVAILABLE_RESULT, owned no-result send, no disposition
task refusal + result audit failure -> AUDIT_UNAVAILABLE_RESULT, owned no-result send,
  no disposition
each no-result inner.send synchronous throw/rejection -> complete matching generation first,
  fixed "audited MCP transport failure" rejection, one sanitized onerror, idempotent close,
  pending zero, no disposition
no-result completion hook throws after a fulfilled fixed-response send ->
  completeNoResultOutbound is attempted exactly once, matching generation is retired in its
  finally, adapter rejects only "audited MCP transport failure", onerror is sanitized once,
  inner close starts once, drain reaches pending zero, dispositionAttempts remains 0, raw
  completion error is absent, and completion is not retried
cancel before a same-generation no-result claim -> release is drop,
  claimNoResultOutbound returns identity-owned drop, fixed replacement is not sent,
  completeNoResultOutbound is called exactly once, pending reaches zero, no disposition
close before a same-generation no-result claim -> same identity-owned drop/no-send/no-
  disposition retirement
cancel then close and close then cancel while no-result claim is gated -> first terminal
  signal keeps release drop; after the gate both return drop and never invoke inner.send
cancel/close after claimNoResultOutbound has synchronously changed release pending to send ->
  cannot revoke the claimed fixed-response send
stale/replaced generation no-result drop -> completion with the stale generation does not
  retire or mutate the newer generation; newer generation survives and remains sendable
attempt audit failure -> ATTEMPT_FAILURE_RESULT still uses completeDirectResponse with its
  generation; fulfillment/failure retains existing behavior and no disposition
```

Assert none of these fixed replacements is returned as `untracked` or dropped while its
generation remains current. Inject the completion failure with a deterministic
`CoordinatorHooks.beforeNoResultCompletion` hook carrying fictional raw text; implement
`completeNoResultOutbound()` as `try { await hook } finally { retire matching generation }`
so the test proves both fixed rejection and terminal retirement.

- [ ] **Step 6: Write the complete refusal/duplicate matrix**

Retain all existing assertions and add disposition expectations:

```text
normal success -> transport result + local send disposition
handler error -> error result + local send disposition
unknown string -> UNKNOWN_TOOL result + local send disposition
missing/non-string name -> BAD_INPUT result + local send disposition
malformed arguments/timezone -> BAD_INPUT result + local send disposition
task refused before callback -> SDK_REFUSAL result + local send disposition
task-capable callback short-circuit -> SDK_REFUSAL result + local send disposition
duplicate in-flight ID -> independent DUPLICATE_REQUEST_ID result + suppressed disposition
attempt failure -> no result/disposition and existing fixed response
result failure -> no disposition and existing fixed completed-withheld/AUDIT_UNAVAILABLE
SDK emits no outbound before drain -> suppressed disposition
numeric 0 and string "0" remain distinct
tombstoned response ID -> identity-token drop, inner.send call count 0
truly unrelated response ID -> untracked and passed through
```

Unknown/non-string raw names remain absent from verbs and payloads.

Add a deterministic late-response test: retire generation A, then send a second SDK response
with A's request ID through the real adapter before the queued tombstone cleanup microtask.
`handleOutbound()` must synchronously capture A's opaque generation before its first await;
after cleanup, `claimOutbound(requestId, capturedCorrelation)` still returns `drop` with A's
generation. The adapter must not call `inner.send`, completion must not append a second
disposition, and A's generation must not retire a later generation B. A response whose ID
was absent from both maps at synchronous capture is the only response case that returns
`untracked` and reaches `inner.send`, even if that ID is admitted later.

Migrate every direct `handleOutbound()` expectation to account for enumerable
`correlation`. In `test/h4-audit-state.test.ts` the exact sites/cases are:

```text
close-at-start
cancel-at-start
forwardedLifecycleCases: forwarded-cancel
forwardedLifecycleCases: forwarded-close
withheld
fallback-audit
task-audit
refused
numeric request ID 0 cancelled while result is pending
running-close
```

For each, stop comparing against a two-key object. Assert `action` and `message` exactly,
then assert the correlation behavior explicitly:

```ts
expect(outbound.correlation.kind).toBe("pending");
if (outbound.correlation.kind !== "pending") {
  throw new Error("expected pending outbound correlation");
}
expect(typeof outbound.correlation.generation).toBe("symbol");
```

The four result-audit-failure cases (`withheld`, `fallback-audit`, `task-audit`, `refused`)
also assert `outbound.correlation.result === "no_result"`; durable suppression cases assert
`result === "durable"`.

`test/h4-audit-transport.test.ts` currently has no direct `handleOutbound()` call. Cover its
enumerable correlation behavior through the real adapter: pending durable response,
pending no-result fixed replacement, tombstoned late response, and truly unrelated response
must respectively reach durable claim, no-result claim, identity drop, and untracked
passthrough. If a direct `handleOutbound()` assertion is introduced while implementing these
tests, apply the same explicit `action`/`message`/`correlation` assertions; no exact
two-key-object expectation may remain in either H4 file.

- [ ] **Step 7: Run Task 2 RED**

```bash
bun test test/h4-audit-state.test.ts test/h4-audit-transport.test.ts
```

Expected: deterministic failures because the coordinator still calls the transitional
`resultAtCommit`, has no result event ID/disposition state, treats post-selection
cancellation as late, and cannot distinguish fulfilled from uncertain send.

- [ ] **Step 8: Implement the pending-call state**

Replace `resultAuditLinearized` with:

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

Keep `generation`, `executionStarted`, `queuedOutcome`, `release`, and opaque tombstones.
`queuedOutcome ??=` remains the first-terminal-winner operation and occurs synchronously
before queuing/awaiting cleanup.

`deliveryState: "no_result"` means exactly that no durable `tool:<name>` result
authorization exists, so no disposition can ever be appended. It has two owned response
paths:

```text
attempt audit failure -> InboundDecision.respond(ATTEMPT_FAILURE_RESULT, generation);
  adapter sends through the existing direct-response branch and retires with
  completeDirectResponse(requestId, generation)
result audit failure after handler/refusal -> terminalReplacement is
  COMPLETED_RESULT_WITHHELD or AUDIT_UNAVAILABLE_RESULT; handleOutbound captures
  pending correlation { generation, result:"no_result" }; adapter uses the separate
  no-result claim/completion path defined in Step 11
```

Neither path calls `disposition()`. `no_result` is not `untracked`, and a matching
generation's fixed response must not be dropped merely because `resultEventId` is absent.

- [ ] **Step 9: Implement result authorization**

`terminalAudit()` must:

```text
guard one result authorization attempt
set result_pending
snapshot zero IDs/count only when a terminal signal already exists
await auditSink.result(... delivery:"transport")
store returned eventId string
set preclaim
if a terminal signal arrived at any point before preclaim completion, force release drop
never call disposition from inside a finalizer callback
```

Type the coordinator property as `DispositionAuditSink`. Until Task 4 changes the public
`AuditSink` name, type the constructor parameter as
`AuditSink | DispositionAuditSink` so unchanged `src/mcp/server.ts` stays
TypeScript-green. Before assigning the property, narrow without a cast:

```ts
function isDispositionAuditSink(
  sink: AuditSink | DispositionAuditSink,
): sink is DispositionAuditSink {
  return "disposition" in sink && typeof sink.disposition === "function";
}
```

Reject a legacy-only sink with the existing fixed audit-unavailable construction failure;
production `eventAuditSink` and every Task 2 H4 sink satisfy the guard. Task 4 changes the
constructor parameter to the final `AuditSink` and removes this transitional guard.

Replace every coordinator use of positional `result()` and `resultAtCommit()` with the
record-form `DispositionAuditSink.result()`, including the independent duplicate path. On
result failure, preserve the existing fixed replacement selection and store no event ID.

After this step,
`rg -n 'FinalizeResultAudit|resultAtCommit' src/mcp/audit-coordinator.ts` must return no
matches. Do not require those bridge symbols to be absent from either H4 sink in Task 2:
they remain required for structural compatibility with unchanged server/direct entry
points. The compatibility exports and H4 bridge members are removed together in Task 4.

- [ ] **Step 10: Implement one disposition attempt**

Add an identity-checked helper:

```ts
private async ensureDisposition(
  entry: PendingCall,
  disposition: AuditDisposition,
): Promise<void> {
  if (entry.dispositionAttempted || !entry.resultEventId) return;
  entry.dispositionAttempted = true;
  try {
    await this.auditSink.disposition(
      entry.actor,
      entry.tool,
      entry.resultEventId,
      disposition,
    );
  } finally {
    entry.deliveryState = "disposed";
  }
}
```

Production must additionally record a sanitized audit failure for adapter close/error
handling, but it must not retry and must retire only the matching generation.

- [ ] **Step 11: Implement the irreversible outbound claim**

Before any await in `handleOutbound()`, snapshot response correlation by identity and carry it
through the adapter:

```ts
export type OutboundCorrelation =
  | {
      kind: "pending";
      generation: symbol;
      result: "durable" | "no_result";
    }
  | { kind: "tombstone"; generation: symbol }
  | { kind: "untracked" };
```

Use `entry.generation` itself as the opaque tombstone token when retiring an entry; do not
allocate a different token that loses the request generation identity. Extend
`OutboundDecision` so every response decision carries its captured
`OutboundCorrelation`. Notifications/non-response messages use `untracked`.

Add the separate no-result API:

```ts
export type NoResultOutboundClaim =
  | { action: "send"; generation: symbol }
  | { action: "drop"; generation: symbol };

claimNoResultOutbound(
  requestId: RequestId,
  correlation: Extract<OutboundCorrelation, { kind: "pending" }>,
): Promise<NoResultOutboundClaim>;

completeNoResultOutbound(
  requestId: RequestId,
  generation: symbol,
): Promise<void>;
```

`claimNoResultOutbound()` accepts only `correlation.result === "no_result"`. If the current
entry still has that generation and `deliveryState === "no_result"` with a fixed terminal
replacement, it must also honor `entry.release` and the first terminal signal:

```text
same generation + release pending -> synchronously set release send and return send
same generation + release drop from cancel/close -> return identity-owned drop
same generation + release send -> never let later cancel/close convert it to drop
retired/replaced generation -> return identity-owned drop
```

It never returns `untracked`. Both send and drop claims finish through
`completeNoResultOutbound()`, which retires only the matching generation and never calls
`ensureDisposition()`. It invokes the optional test hook
`beforeNoResultCompletion` once and uses `finally` internally to retire the still-matching
generation even when that hook throws; the thrown completion failure propagates to the
adapter for sanitization and is never retried.

Change the claim to
`claimOutbound(requestId: RequestId, correlation: OutboundCorrelation):
Promise<OutboundClaim>`. After its existing hook and serialized checks:

```text
captured pending + same current generation -> decide only for that generation
captured pending + generation retired/replaced -> drop with captured generation
captured tombstone -> drop with captured generation even if cleanup already ran
captured untracked -> untracked even if a later generation now uses the same ID
captured pending result:"no_result" -> route to claimNoResultOutbound, never claimOutbound
preclaim + release drop -> drop with generation/outcome
preclaim + send allowed -> synchronously set release_claimed and return send/generation
release_claimed/disposed pending generation -> drop with that generation; never claim twice
```

There must be no `await` between receipt of the send claim in the adapter and invocation of
`inner.send()`. A response observed while its ID is tombstoned is never reclassified as
`untracked` after an await: the captured opaque generation is the identity proof for its
drop. Only a response observed with an ID absent from both `pending` and `tombstones` is
captured `untracked`.

- [ ] **Step 12: Implement audited transport send classification**

For a tracked response:

```ts
if (
  decision.correlation.kind === "pending" &&
  decision.correlation.result === "no_result"
) {
  const noResultClaim = await coordinator.claimNoResultOutbound(
    requestId,
    decision.correlation,
  );
  if (noResultClaim.action === "drop") {
    let noResultDropCompletionFailed = false;
    try {
      await coordinator.completeNoResultOutbound(
        requestId,
        noResultClaim.generation,
      );
    } catch {
      noResultDropCompletionFailed = true;
    }
    if (noResultDropCompletionFailed) {
      this.failClosed();
      throw new Error("audited MCP transport failure");
    }
    return;
  }

  let noResultSendFailed = false;
  let noResultCompletionFailed = false;
  try {
    const sendPromise = inner.send(outbound, sendOptions);
    await sendPromise;
  } catch {
    noResultSendFailed = true;
  }
  try {
    await coordinator.completeNoResultOutbound(
      requestId,
      noResultClaim.generation,
    );
  } catch {
    noResultCompletionFailed = true;
  }
  if (noResultSendFailed || noResultCompletionFailed) {
    this.failClosed();
    throw new Error("audited MCP transport failure");
  }
  return;
}

const claim = await coordinator.claimOutbound(requestId, decision.correlation);
if (claim.action === "drop") {
  try {
    await coordinator.completeOutbound(requestId, claim.generation, {
      status: "suppressed",
      ...(claim.outcome ? { outcome: claim.outcome } : {}),
    });
  } catch {
    this.failClosed();
    throw new Error("audited MCP transport failure");
  }
  return;
}
if (claim.action === "untracked") {
  await inner.send(outbound, sendOptions);
  return;
}

let disposition: AuditDisposition;
let sendFailed = false;
try {
  const sendPromise = inner.send(outbound, sendOptions);
  await sendPromise;
  disposition = { status: "released" };
} catch {
  sendFailed = true;
  disposition = { status: "send_uncertain" };
}

let dispositionFailed = false;
try {
  await coordinator.completeOutbound(requestId, claim.generation, disposition);
} catch {
  dispositionFailed = true;
}

if (sendFailed || dispositionFailed) {
  this.failClosed();
  throw new Error("audited MCP transport failure");
}
```

There is no `await` between a no-result `send` claim and `inner.send()`. Independently capture
`noResultSendFailed` and `noResultCompletionFailed`; never store or rethrow either raw
exception. After the send settles, attempt exactly one identity-owned
`completeNoResultOutbound()` regardless of send outcome. After completion settles, if either
flag is true, call idempotent `failClosed()` and throw only
`new Error("audited MCP transport failure")`. Completion failure cannot bypass fail-close,
cannot be retried, and cannot append disposition. Fulfillment plus successful completion
retires the matching generation; send or completion failure still leaves matching
retirement to `completeNoResultOutbound()`'s internal `finally`. No result authorization or
disposition is fabricated.
`COMPLETED_RESULT_WITHHELD` and `AUDIT_UNAVAILABLE_RESULT` therefore remain locally
sendable, identity-owned fixed responses rather than being dropped or treated as untracked.

For an identity-owned no-result `drop`, the adapter must call
`completeNoResultOutbound(requestId, generation)` exactly once before returning. Matching
cancel/close generations retire with no send and no disposition. A completion failure is
caught and converted through the same idempotent `failClosed()` plus fixed
`"audited MCP transport failure"` rejection; raw completion text is never exposed and the
completion is not retried. Because completion compares generation identity, a stale/replaced
drop cannot delete or mutate the newer pending generation.

Calling `inner.send()` is the irreversible point, including a synchronous throw. After a
send invocation fails, catch only to select `send_uncertain`; do not resolve successfully and
do not return early. Attempt exactly one disposition first, then execute the existing
idempotent `failClosed()`/sanitized rejection path. A disposition failure follows the same
fixed close/rejection path. The outer adapter catch may observe the fixed error but must not
emit a second `onerror`, start a second close, retry disposition, or expose the raw send/audit
error.

- [ ] **Step 13: Complete close/drain and duplicate ownership**

Before retiring any durable-result entry without a send claim, close/drain must attempt
`suppressed`. Duplicate auditing must capture the duplicate result event ID, append its
suppressed disposition, then schedule transport close. Attempt/result failure paths append no
fabricated disposition.

Use this retirement table everywhere:

| State | Retirement rule |
|---|---|
| `no_result` after attempt failure | send fixed response through direct branch; `completeDirectResponse` retires matching generation; no disposition |
| `no_result` after result failure | send fixed replacement through `claimNoResultOutbound`; `completeNoResultOutbound` retires matching generation after fulfillment or failure; no disposition |
| `result_pending` | wait for the one result attempt; do not retire or invent disposition |
| `preclaim` with drop/close/drain | attempt exactly one `suppressed`, then retire matching generation even if append fails |
| `release_claimed` | never suppress; wait for send classification and its one disposition attempt |
| `disposed` | retire only the matching generation; never append again |
| matching tombstone token | drop/no-send; no result exists to dispose and no second append |
| no pending entry and no tombstone | `untracked`; coordinator owns no retirement |

Migrate every existing internal/test call site, not only the happy adapter branch:

```text
AuditCoordinator.drain(): replace completeOutbound(requestId) with generation-owned
  no-result completion only after its fixed-send path settles, or
  ensureDisposition(suppressed) + matching durable-result retirement
AuditCoordinator fixed result-audit-failure branches: retain the entry as
  pending/no_result with terminalReplacement until claimNoResultOutbound and
  completeNoResultOutbound finish; never discard it merely because resultEventId is absent
AuditedServerTransport decision.action === "drop": for a response ID, use the decision's
  captured correlation to obtain the identity-owned claim and complete the matching drop as
  suppressed; do not re-resolve by bare ID or call the old completion signature
AuditedServerTransport claim.action === "drop": pass claim.generation and suppressed outcome
AuditedServerTransport claim.action === "send": classify send, then pass generation +
  released/send_uncertain; remove the old finally completion
AuditedServerTransport pending/no_result correlation: bypass claimOutbound, call
  claimNoResultOutbound, invoke inner.send immediately, and always call
  completeNoResultOutbound; never call disposition
AuditedServerTransport direct attempt-failure response: keep completeDirectResponse(id,
  generation), which is no-result retirement and never writes disposition
all claimOutbound assertions in both H4 files: construct/capture the exact
  OutboundCorrelation, assert the full OutboundClaim object, preserve its generation, and
  pass that generation plus the exact disposition to completion
all completion-only H4 calls ("task", "refused", "fast", "slow", numeric 0, string "0",
  reject, withheld/error/fallback cases): first obtain/retain their claim or use the explicit
  no-result/direct-generation retirement API; no bare completeOutbound(requestId) remains
```

After migration,
`rg -n 'completeOutbound\\([^,\\)]*\\)' src/mcp/audit-coordinator.ts
src/mcp/audited-transport.ts test/h4-audit-state.test.ts
test/h4-audit-transport.test.ts` must return no old one-argument call. Add assertions that
drain waits for a held disposition, retires no-result failures without disposition, and
never turns a claimed send into suppressed.

- [ ] **Step 14: Run Task 2 GREEN and static gates**

```bash
bun test test/h4-audit-state.test.ts test/h4-audit-transport.test.ts
bunx tsc --noEmit
bunx biome check \
  src/mcp/audit-coordinator.ts \
  src/mcp/audited-transport.ts \
  test/h4-audit-state.test.ts \
  test/h4-audit-transport.test.ts
git diff --check
```

Expected: focused tests pass; every durable transport result has exactly one attempted
disposition; send invocation can never become suppressed; `bunx tsc --noEmit` stays green
because both H4 recording sinks remain `TransitionalAuditSink`-assignable through unchanged
`buildServer` and `invokeTool` signatures while the coordinator consumes their disposition
surface.

- [ ] **Step 15: Commit Task 2 and obtain reviews**

```bash
git add \
  src/mcp/audit-coordinator.ts \
  src/mcp/audited-transport.ts \
  test/h4-audit-state.test.ts \
  test/h4-audit-transport.test.ts
git commit -m "fix(mcp): classify local result disposition"
```

Require exact four-path scope, fresh Luna with no Critical/Important, and binding Sol PASS
before Task 3.

### Task 3: Identity-Owned Server Lifecycle

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `test/h4-audit-transport.test.ts`

**Interfaces:**
- Consumes: Task 2 audited adapter close/drain and coordinator lifecycle
- Produces: one identity-owned `connecting|open|closing|closed` facade record, reentrant teardown, no successor admission during teardown, no connect success after close

- [ ] **Step 1: Add a start-rejecting, close-gated transport fixture**

In `test/h4-audit-transport.test.ts`, define a transport whose:

```text
start() signals startEntered then rejects with a fixed fictional error
close() signals closeEntered, waits closeGate, invokes onclose once, then resolves
retains the installed inner onclose callback for an explicit late-callback test
```

The fixture records exact start/close counts and never contains owner data.

- [ ] **Step 2: Write failed-connect successor RED**

Drive:

```text
connect owner A
A start rejects
wait until A close is gated
attempt connect B
```

Required: B rejects `already connected or closing`. Baseline RED: connect failure cleared
`active` before awaiting A close, so B is admitted.

- [ ] **Step 3: Write close-during-connect RED**

Use a start-pending transport:

```text
connect A remains pending
server.close() begins teardown
underlying start/connect later resolves
```

Required: A's public connect rejects with fixed `Minime connection closed during connect`;
it must not resolve successfully after teardown began.

- [ ] **Step 4: Write teardown reentrancy and late-owner RED**

Assert:

```text
explicit close, adapter onclose, and SDK close all receive the same teardown promise
inner onclose reentry does not call close twice
after A teardown, B connects
retained late A callbacks do not clear or close B
C is rejected while B owns the facade
server.close() closes B exactly once
```

- [ ] **Step 5: Run Task 3 RED**

```bash
bun test test/h4-audit-transport.test.ts -t "server owner lifecycle"
```

Expected: FAIL because the current facade has unowned `active`/`closing`, admits B during A
teardown, and can report a connect that resolves after close.

- [ ] **Step 6: Implement the connection owner**

In `src/mcp/server.ts` define:

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

Replace `active` and global `closing` with `let owner: ConnectionOwner | undefined`.

- [ ] **Step 7: Implement reentrant beginTeardown**

Install a deferred promise before any close call:

```text
if target.teardown exists, return it
create deferred
target.state = closing
target.teardown = deferred.promise
start target.adapter.close() immediately
start/await target.sdkServer.close() through the same owner
await adapter close, SDK close, adapter drain
finally set target closed
clear owner only when owner === target
settle deferred exactly once
```

`adapter.onclose = () => { void beginTeardown(target); }`. Reentry observes the installed
promise and cannot start another teardown.

- [ ] **Step 8: Implement connect state validation**

`connect()` must:

```text
reject while owner is installed
construct/register SDK server, coordinator, adapter
install owner in connecting before sdkServer.connect()
on rejection: await beginTeardown(owner), then rethrow
after resolution: if state is no longer connecting, await teardown and throw
otherwise set open and resolve
```

Use the fixed lifecycle message `Minime connection closed during connect`. Never expose the
underlying fictional/transport error on an outward MCP wire.

- [ ] **Step 9: Implement facade close**

`close()` returns immediately when no owner exists and otherwise returns the exact
`beginTeardown(owner)` promise. It does not install or clear any separate global closing
state.

- [ ] **Step 10: Run Task 3 GREEN and compatibility**

```bash
bun test test/h4-audit-transport.test.ts
bun test test/h4-audit-state.test.ts test/h4-audit-transport.test.ts
bunx tsc --noEmit
bunx biome check src/mcp/server.ts test/h4-audit-transport.test.ts
git diff --check
```

Expected: lifecycle and prior disposition tests pass; no stale owner changes its successor.

- [ ] **Step 11: Commit Task 3 and obtain reviews**

```bash
git add src/mcp/server.ts test/h4-audit-transport.test.ts
git commit -m "fix(mcp): own facade connection lifecycle"
```

Require exact two-path scope, fresh Luna with no Critical/Important, and binding Sol PASS
before Task 4.

### Task 4: Direct Invocation and Integration Expectations

**Files:**
- Modify: `src/mcp/audit.ts`
- Modify: `src/mcp/audit-coordinator.ts`
- Modify: `src/mcp/tools/registry.ts`
- Modify: `test/h4-audit-state.test.ts`
- Modify: `test/h4-audit-transport.test.ts`
- Modify: `test/m2.tools.test.ts`
- Modify: `test/m6.leak.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 complete audit API with the temporary bridge, disposition transport,
  and server facade
- Produces: the amendment's exact final `AuditSink` with no compatibility types,
  `FinalizeResultAudit`, or `resultAtCommit`; source-compatible direct two-phase invocation,
  real-transport three-phase H4/M2 evidence, production disposition persistence evidence,
  and fixed direct-call failure/leak compatibility

- [ ] **Step 1: Write direct invokeTool compatibility RED**

In `test/m6.leak.test.ts`, first make the RED-stage recording sink implement
`TransitionalAuditSink` with the same exact legacy/new overload and temporary
`resultAtCommit()` as the Task 2 H4 sinks. This keeps the RED test assignable to unchanged
legacy `invokeTool()` while allowing it to observe record-form calls after implementation.
Add assertions:

```text
normal direct call -> attempt then delivery:"direct" result, no disposition
direct handler error -> direct result with fixed error, no disposition
attempt failure -> handler does not begin; existing retry:true INTERNAL
result failure after success -> completed_result_withheld
result failure after error -> AUDIT_UNAVAILABLE
direct result IDs remain capped and uncapped count remains exact
direct result never enters access eligibility
```

The direct recording sink's `disposition()` must fail the test if invoked. Step 6 reduces
this sink to the exact final `AuditSink` after `invokeTool()` changes.

- [ ] **Step 2: Update M2 phase expectations**

In `test/m2.tools.test.ts`, for each transport call assert:

```text
tool:<name>:attempt
tool:<name> with delivery:"transport"
tool:<name>:disposition with status:"released"
```

For two normal calls expect six rows ordered attempt/result/disposition per call. Assert:

```text
result_event_id is a decimal string
result_event_id equals the matching result row id::text
disposition has no returned IDs for released
normal wire shape and actor attribution remain unchanged
```

- [ ] **Step 3: Preserve direct M6 leak evidence and add production disposition persistence evidence**

The 200 fuzz calls in `test/m6.leak.test.ts` are direct `invokeTool()` calls, not transport
calls. Keep all 200 tier-0/tier-2 sentinel, SQL injection, unlock, RLS, raw-name, fixed
replacement, and leak assertions. Add exact audit-phase assertions:

```text
each successful direct invocation -> one attempt + one delivery:"direct" result
all direct invocations -> no disposition
attempt failure -> no handler/result/disposition
result failure -> fixed response and no disposition
direct result IDs remain capped; returned_count remains uncapped
direct results never enter released transport access eligibility
```

Do not claim transport release evidence from these 200 calls. Three-phase transport evidence
comes from Task 2's real `AuditedServerTransport` matrices and Task 4 Step 2's real M2 MCP
transport calls.

Replace the existing positional `eventAuditSink.result(...)` test near the current line 333
(`"all non-release result outcomes persist empty IDs and zero count"`) rather than leaving
or merely deleting it. The replacement production integration test must:

```text
advance the disposable events sequence above Number.MAX_SAFE_INTEGER without JS-number
  coercion
for each of released, suppressed/completed_not_released, and send_uncertain:
  call eventAuditSink.result(..., { returnedIds:[SOURCE_SENTINEL], returnedCount:137,
    error:"INTERNAL", delivery:"transport" })
  retain DurableResultAudit.eventId as the exact decimal string
  call eventAuditSink.disposition(actor, tool, eventId, disposition)
query result/disposition rows from the disposable DB and compare
  payload.result_event_id byte-for-byte with result id::text and returned eventId
released payload keys are exactly result_event_id,status
send_uncertain payload keys are exactly result_event_id,status
suppressed payload keys are exactly
  outcome,result_event_id,returned_count,returned_ids,status
suppressed returned_ids is [] and returned_count is 0
all three disposition payloads omit actor copies, returned/source IDs, response content,
  params, titles, paths, error and raw transport/SDK text
ERROR_SENTINEL remains only separate raw handler/SDK test data and appears in neither the
  result payload nor any disposition payload
a second disposition append for the same result_event_id rejects on
  events_tool_disposition_result_event_uidx; exactly one disposition row remains
```

This test covers the final record API at the former positional production call site,
lossless correlation, exact allowed payload keys, suppression sanitization, and database
uniqueness. It does not treat a direct M6 call as transport evidence.

`ResultAuditRecord.error` is an approved fixed code, not an arbitrary exception message.
Production `eventAuditSink` persists only the caller-supplied fixed codes from trusted
coordinator/registry paths (for example `INTERNAL`, `BAD_INPUT`, `UNKNOWN_TOOL`,
`SDK_REFUSAL`, or `DUPLICATE_REQUEST_ID`). Those paths must convert raw handler, SDK, and
transport errors before constructing the record; no raw error text may enter this field.
Keep `ERROR_SENTINEL` solely in separate hostile input/handler data and assert the queried
result and disposition payloads do not contain it.

Advance the sequence with a decimal string parameter, never a JavaScript numeric literal:

```ts
await sql`
  select setval(
    pg_get_serial_sequence('events', 'id'),
    ${"9007199254740992"}::bigint,
    true
  )`;
```

The next event ID must be asserted as the exact string `"9007199254740993"` before it is
used as `result_event_id`.

- [ ] **Step 4: Create and guard the Task 4 disposable database**

Create the scratch database before running any selection from `test/m6.leak.test.ts`,
because Bun executes that file's `beforeAll` even with `-t`:

```bash
H4_DB_NAME="minime_h4_disposition_$$"
H4_ADMIN_URL="postgres://minime:minime@127.0.0.1:${MINIME_PG_PORT:-5432}/postgres"
H4_DB_URL="postgres://minime:minime@127.0.0.1:${MINIME_PG_PORT:-5432}/${H4_DB_NAME}"
createdb --maintenance-db="$H4_ADMIN_URL" --owner=minime "$H4_DB_NAME"
trap 'dropdb --if-exists --maintenance-db="$H4_ADMIN_URL" "$H4_DB_NAME"' EXIT
test "$H4_DB_NAME" != "minime"
test "$H4_DB_NAME" != "minime_test"
case "$H4_DB_NAME" in minime_h4_disposition_*) ;; *) exit 1 ;; esac
```

Run Steps 4–9 in the same shell session. Stop before Bun if creation or any guard fails;
keep the trap installed through Step 9 so every early exit still deletes the database.

- [ ] **Step 5: Run Task 4 direct RED against the guarded scratch database**

Run exactly:

```bash
MINIME_SCRATCH_TEST_DATABASE_URL="$H4_DB_URL" \
  bun test test/m6.leak.test.ts -t "direct audit disposition compatibility"
```

The override is mandatory even for a filtered selection; its file-level `beforeAll` may
reset and seed only the disposable target. Expected RED: registry still calls the old
positional result API and has no `delivery:"direct"` contract. If output names `minime` or
`minime_test` as the reset target, stop immediately.

- [ ] **Step 6: Implement direct compatibility and remove the temporary bridge**

In `invokeTool()` retain its signature. After execution:

```ts
const audit = await auditSink.result(
  ctx.actor,
  tool.name,
  hash,
  {
    returnedIds: ids,
    returnedCount,
    ...(error ? { error } : {}),
    delivery: "direct",
  },
);
void audit.eventId;
```

Return the original result only after the direct result is durable. Preserve the existing
attempt/result failure mappings verbatim. Never call `auditSink.disposition()`.

In `src/mcp/audit.ts`, now delete `LegacyResultAuditRecord`, `FinalizeResultAudit`,
`LegacyAuditSink`, `DispositionAuditSink`, `TransitionalAuditSink`,
`persistLegacyResult()`, the positional `compatibleResult()` overload, and
`resultAtCommit()`. Rename the record-form production implementation to `result` and leave
the exact final `AuditSink` declaration from **Shared interfaces**.

In `src/mcp/audit-coordinator.ts`, change `DispositionAuditSink` imports/usages to the final
`AuditSink`, change the constructor parameter to `AuditSink`, and delete
`isDispositionAuditSink`. In both H4 test files, replace
`implements TransitionalAuditSink` with `implements AuditSink`, delete the legacy positional
overload and temporary `resultAtCommit()`, and retain only the record-form `result()` plus
`disposition()`. Do the same bridge removal in the M6 recording sink.

At the former positional production call near current M6 line 333, call
`eventAuditSink.result()` with the final `ResultAuditRecord` object and use its returned
`eventId` in `eventAuditSink.disposition()` exactly as specified in Step 3. No positional
`eventAuditSink.result()` invocation may remain. Then prove the bridge is gone:

```bash
if rg -n \
  'LegacyResultAuditRecord|FinalizeResultAudit|LegacyAuditSink|DispositionAuditSink|TransitionalAuditSink|resultAtCommit|compatibleResult|persistLegacyResult' \
  src/mcp/audit.ts src/mcp/audit-coordinator.ts src/mcp/tools/registry.ts \
  test/h4-audit-state.test.ts test/h4-audit-transport.test.ts test/m6.leak.test.ts; then
  exit 1
fi
test "$(rg -c 'eventAuditSink\\.result' test/m6.leak.test.ts)" -eq 1
```

The single remaining production-sink call is the Step 3 record-object call; the final
`AuditSink` signature plus `bunx tsc --noEmit` rejects any positional form.

- [ ] **Step 7: Run Task 4 direct GREEN and static compatibility**

```bash
MINIME_SCRATCH_TEST_DATABASE_URL="$H4_DB_URL" \
  bun test test/m6.leak.test.ts -t "direct audit disposition compatibility"
bun test test/h4-audit-state.test.ts test/h4-audit-transport.test.ts
bunx tsc --noEmit
bunx biome check \
  src/mcp/audit.ts \
  src/mcp/audit-coordinator.ts \
  src/mcp/tools/registry.ts \
  test/h4-audit-state.test.ts \
  test/h4-audit-transport.test.ts \
  test/m2.tools.test.ts \
  test/m6.leak.test.ts
git diff --check
```

Expected: filtered direct, pure H4, and static gates pass. The filtered M6 `beforeAll`
operates only on `H4_DB_URL`; the final interface is exact and bridge-free.

- [ ] **Step 8: Run separately authorized DB integration suites sequentially**

Run each in a separate Bun process because each suite resets only its disposable target:

```bash
MINIME_SCRATCH_TEST_DATABASE_URL="$H4_DB_URL" bun test test/m1.schema.test.ts
MINIME_SCRATCH_TEST_DATABASE_URL="$H4_DB_URL" bun test test/access-boost.test.ts
MINIME_SCRATCH_TEST_DATABASE_URL="$H4_DB_URL" bun test test/m2.tools.test.ts
MINIME_SCRATCH_TEST_DATABASE_URL="$H4_DB_URL" bun test test/m6.leak.test.ts
```

Expected: all pass. This is the only authorized standalone M6 run. Do not run canonical
`bun test` or `make verify`. Step 5 and Step 7 are filtered TDD runs against the same guarded
scratch target and are not standalone full-suite M6 runs.

- [ ] **Step 9: Drop the integration database and prove cleanup**

```bash
dropdb --if-exists --maintenance-db="$H4_ADMIN_URL" "$H4_DB_NAME"
trap - EXIT
if psql "$H4_ADMIN_URL" -Atqc \
  "select 1 from pg_database where datname = '$H4_DB_NAME'" | grep -q 1; then
  exit 1
fi
```

- [ ] **Step 10: Run the final restricted acceptance gate**

```bash
bun test test/h4-audit-state.test.ts test/h4-audit-transport.test.ts
bunx tsc --noEmit
bunx biome check \
  src/db/repo.ts \
  src/mcp/audit.ts \
  src/mcp/audit-coordinator.ts \
  src/mcp/audited-transport.ts \
  src/mcp/server.ts \
  src/mcp/tools/registry.ts \
  test/setup.ts \
  test/m1.schema.test.ts \
  test/access-boost.test.ts \
  test/h4-audit-state.test.ts \
  test/h4-audit-transport.test.ts \
  test/m2.tools.test.ts \
  test/m6.leak.test.ts
git diff --check
make check-subsystems
```

Expected: all permitted checks pass without fixes or generated repository artifacts.

- [ ] **Step 11: Prove frozen scope, dependencies, and protected paths**

```bash
git diff --name-only a71bbf4847079a702596380e4ae8477fcbfcbce0...HEAD
git diff a71bbf4847079a702596380e4ae8477fcbfcbce0...HEAD -- \
  package.json bun.lock .env.example data db-dump scripts/repairs \
  fixtures/mcp-tools-list-sdk-1.29.json
bun -e 'import pkg from "./node_modules/@modelcontextprotocol/sdk/package.json"; console.log(pkg.version)'
git status --short
```

Expected: only the authorized normative and four-task paths changed; protected diff is empty;
SDK prints `1.29.0`; no scratch database, generated scorecard, temp file, or unrelated edit
remains.

- [ ] **Step 12: Commit Task 4**

```bash
git add \
  src/mcp/audit.ts \
  src/mcp/audit-coordinator.ts \
  src/mcp/tools/registry.ts \
  test/h4-audit-state.test.ts \
  test/h4-audit-transport.test.ts \
  test/m2.tools.test.ts \
  test/m6.leak.test.ts
git commit -m "test(audit): prove disposition integration"
```

- [ ] **Step 13: Obtain final independent reviews**

Provide the exact diff from
`a71bbf4847079a702596380e4ae8477fcbfcbce0...HEAD`, RED/GREEN output, disposable DB
creation/deletion proof, path/dependency proof, and all four task commit SHAs to a fresh Luna
reviewer. Resolve every Critical/Important within authorized scope. Then obtain a fresh
binding Sol review.

Expected: Luna has zero unresolved Critical/Important and binding Sol returns explicit PASS.
Do not merge on BLOCK.

## Global stop conditions

Stop for the owner if:

- the clean starting HEAD does not contain normative ancestor
  `5209b24669187e2f30e74d0f31378c93f55ad26f`, the frozen diff baseline is not
  `a71bbf4847079a702596380e4ae8477fcbfcbce0`, or worktree scope differs from the
  authorized map;
- any task needs a path outside its exact file list;
- result IDs pass through a JavaScript number;
- payload selection/submission is described as durability;
- `released` is described as peer receipt/use;
- post-claim cancellation can produce suppressed;
- an invoked failing send produces suppressed rather than send_uncertain;
- a disposition append is retried after failure/unknown completion;
- direct or uncorrelated results enter access ranking;
- historical access rows are grandfathered;
- disposition/pending state gains raw parameters, response content, IDs, SDK errors, titles,
  paths, or actor copies;
- teardown is installed after a close call/await;
- connect resolves after teardown begins;
- a stale owner can clear a successor;
- disposable DB validation or deletion proof fails;
- any command would reset `minime` or `minime_test`;
- canonical `bun test`, `make verify`, another M6 run, dependency change, SDK-private import,
  outbox, peer acknowledgement, or new subsystem becomes necessary;
- two consecutive task/review cycles fail;
- fresh binding Sol returns BLOCK.
