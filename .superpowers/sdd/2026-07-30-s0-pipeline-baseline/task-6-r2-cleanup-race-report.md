# Task 6 R2 owned teardown report

Status: implementation GREEN for the focused lifecycle and safety gates; the final
unscoped gate is GREEN at the pre-commit candidate.

## Binding identity and scope

- `TASK6_R2_PLAN_SHA`: `4df61a330264d6dce4a2d751b0f8505000dbb48f`
- implementation paths: `test/support/test-database.ts`,
  `test/test-database-isolation.test.ts`, `test/eval-database-isolation.test.ts`,
  `test/fixtures/owned-db-child.ts`, `test/setup.ts`, `test/m15.roles.test.ts`,
  and this report only
- requested commit message: `test: make owned database teardown authoritative`

No application source, migration, script, package/lock, TypeScript configuration, Make,
workflow, grant, privacy/egress, protected data/settings, or prior frozen range was changed.

## I1/Minor review remediation

The independent implementation review found two scoped adapter issues. First, an optional
exported `TestDatabaseAdmin.teardown` capability let an injected admin bypass the authoritative
private cleanup helper. Second, decoding a malformed percent-encoded admin username after
`factory()`/`reserve()` leaked the pool and surfaced raw `URI error` text.

The RED command was:

```text
bun test test/test-database-isolation.test.ts --test-name-pattern 'cleanup capability stays private|malformed encoded admin usernames'
0 pass / 2 fail / 2 expect
I1: interface still contained teardown? and custom teardown bypassed expected drop
Minor: malformed %ZZ returned URI error instead of test_database_invalid
```

The fix removes `teardown?` from the exported interface and default adapter, and makes the
module-private `teardownWithAdmin` revalidate the create plan. Privately branded admins returned
by the default adapter use `admin.drop` only; unbranded injected test doubles retain the frozen
legacy `terminate -> drop` trace. An optional runtime `teardown` property is ignored in either
case. The admin URL is validated/decoded before constructing or reserving the pool. Existing
public `terminate` and `drop` operations remain unchanged; the default `drop` retains the full
fenced, classified, bounded ordinary-drop cycle.

The focused green result is:

```text
bun test test/test-database-isolation.test.ts
71 pass / 0 fail / 404 expect

bun test test/migration-context.test.ts --test-name-pattern 'bootstrap failure closes before disposing only the retained owned handle'
1 pass / 0 fail / 12 expect
```

## RED and implementation

The deterministic RED was written before the adapter change. The new blocker/recheck tests
initially reported `14 pass / 8 fail / 97 expect`; the old adapter stopped after its first
blocked snapshot instead of rechecking. The same-branded-handle retry test independently
failed because the old adapter performed one snapshot rather than the required bounded cycle.

The default adapter now has one module-private teardown path:

1. validate the generated plan and exact target;
2. fence with `alter database "<generated>" with allow_connections false`;
3. take a complete fresh snapshot containing only `pid`, `usename`, and `backend_type`;
4. classify only same-role `client backend` PIDs as eligible; foreign roles, NULL/hidden
   fields, autovacuum, parallel, logical, custom, unknown, duplicate, changed-PID, and mixed
   rows remain blockers;
5. terminate only eligible current-role clients using a positive server timeout of `1000` ms,
   validating the complete boolean result;
6. issue an ordinary `drop database "<generated>"` only after a fresh safe snapshot;
7. on a blocker or SQLSTATE `55006`, consume the current cycle, delay exactly 100 ms unless
   the twentieth cycle has completed, then take a fresh snapshot; no cycle twenty-one occurs;
8. map snapshot, termination, clock, and drop failures to fixed cleanup errors, and clear the
   fence state only after a successful ordinary drop.

The same helper is used by normal branded-handle disposal and post-clone/pre-mint rollback.
Rollback requires the immutable revalidated generated plan and the local `cloneSucceeded`
fact. Clone rejection/collision cannot establish ownership, fence, terminate, drop, or mint.
No `WITH (FORCE)` SQL path remains.

## Added behavioral evidence

- exact `fence -> classify -> terminate eligible -> ordinary drop` trace;
- one blocker cycle followed by a safe fresh snapshot and ordinary drop;
- persistent blockers bounded to twenty complete snapshots with nineteen waits, no drop, and a
  branded handle that remains retryable later;
- PID changes never inherit eligibility across cycles;
- snapshot, termination, malformed-result, clock, and non-`55006` drop failures stop at the
  specified boundary;
- `55006` consumes its cycle and requires a fresh snapshot; persistent `55006` is bounded to
  twenty cycles without a trailing wait;
- background, logical, custom, unknown, mixed, duplicate, foreign, and hidden activity remains
  blocked until a complete safe snapshot;
- extension/provisioning rollback and admin-close precedence use the same teardown contract and
  never mint an unproven handle;
- real `minime_engineer_ro` activity fences the target, performs no termination or drop while
  blocked, then closes and retries the same branded handle through the approved adapter;
- abrupt owned-child, signal, wrapper, and concurrent-wrapper tests preserve fixed, bounded,
  content-free output and clean their exact guarded targets.

## Gate evidence

Passing focused commands from the current implementation:

```text
bun test test/m15.roles.test.ts test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
110 pass / 0 fail / 704 expect

bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
87 pass / 0 fail / 599 expect

bun test test/eval-database-isolation.test.ts
19 pass / 0 fail / 200 expect

bun test test/update-bootstrap.test.ts test/update.test.ts test/backup.test.ts
19 pass / 0 fail / 63 expect

make verify-m0-offline
PASS postgres reachable — postgres://minime:***@localhost:5432/minime_test_verify_m0_63350_594490b1e89a
PASS extension: vector
PASS extension: pgcrypto
PASS embed provider: ollama
PASS llm providers — mocked (MINIME_MOCK_OLLAMA=1)

bunx --package typescript@5.9.3 tsc --noEmit --pretty false
exit 0

bunx biome check test/support/test-database.ts test/test-database-isolation.test.ts \
  test/eval-database-isolation.test.ts test/fixtures/owned-db-child.ts test/setup.ts \
  test/m15.roles.test.ts
Checked 6 files in 22ms. No fixes applied.

bash -n scripts/eval-pmb.sh
exit 0

static safety rg over test/support/test-database.ts
no unsafe matches

git diff --check
exit 0
```

The exact isolated H3 gate, run by the orchestrator after terminating the earlier overlapping
commands, exited naturally with `126 pass / 0 fail / 3682 expect` in `130.18s`. Its immediate
guarded-database count, source-template activity count, and wrapper/owned-child/test process
checks were all zero/empty.

The unscoped `bun test` gate is intentionally run once at the committed candidate and its
result is recorded below.

```text
bun test
1076 pass
1 skip
0 fail
9776 expect() calls
Ran 1077 tests across 51 files. [205.11s]
```

Immediate post-gate checks were clean:

```text
generated_databases: 0
source_template_activity: 0
native role minime: f | t | t
wrapper/owned-child/test process residue: none
```

## Residue and recovery

Earlier residue evidence was invalidated because three executor commands were alive concurrently.
The orchestrator terminated those exact test PIDs, recovered each exact guarded database through
the approved adapter, and then ran H3 in isolation to natural exit. The isolated H3 checks were
clean, and the pre-commit full suite also ended with zero guarded databases, zero source-template
activity, no wrapper/owned-child/test process, and native role posture `f|t|t`. No broad SQL/drop
path was used, and no provider-capable eval or egress path was run.

This report records implementation evidence and is not a review or approval.
