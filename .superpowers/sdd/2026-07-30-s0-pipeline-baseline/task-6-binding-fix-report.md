# Task 6 I-1 binding-fix report: owned bootstrap cleanup order

Status: implementation GREEN; review and joint closure remain external to this report

## Binding identity and scope

- `TASK6_I1_PLAN_SHA`: `4e685e06127e2ed2a5efded951cc933cabe8b6c1`
- frozen Task 6.5 implementation: `4520380f9f41a8507982d7783668f3155013a020..e210235ea9ab7b6c368420ad25e82b3f24d6d81b`
- implementation paths: `test/test-database-isolation.test.ts`,
  `test/eval-database-isolation.test.ts`, and this report only
- exact requested commit message: `test: prove owned bootstrap cleanup order`

No production wrapper, application, H3, configuration, package, Make, workflow, script,
migration, preload, or protected data/settings path was changed.

## RED cause and test-only seam

The first joint Sol review at `e210235ea9ab7b6c368420ad25e82b3f24d6d81b` remained the
authoritative RED: the wrapper contract tests collapsed migration and parent close into one
event, omitted the mandated ordered traces, lacked close-plus-disposal precedence coverage,
and had no real generated-target bootstrap-failure case. The remediation adds no production
hook. A test-only `injectedBootstrap` seam observes the owned URL before a separately modeled
`migrate({ kind: "test" })` phase and `closeDb()` phase, while the existing production wrapper
continues to call one `bootstrapOwnedDatabase()` dependency.

## Exact ordered traces

The wrapper contract test asserts this exact success trace:

```text
plan
provision
set:DATABASE_URL
bootstrap:migrate:test
bootstrap:closeDb
spawn
child:0
dispose
```

The injected migration failure test asserts this exact bootstrap-failure trace:

```text
plan
provision
set:DATABASE_URL
bootstrap:migrate:test:fail
bootstrap:closeDb
dispose
```

The URL assertion is made before the migration event; the child result is recorded before
the wrapper returns from spawn; and no spawn event is permitted on bootstrap or close failure.

## Cleanup precedence

- Close-only rejection: no spawn, one disposal attempt, and `close failed` remains primary.
- Close plus branded disposal rejection: no spawn, exactly one disposal attempt, and the
  wrapper returns fixed `test_database_cleanup_failed` rather than the close error.
- The tests assert complete traces and dispose-attempt counts for both cases.

## Real generated-target bootstrap failure

The eval isolation test uses the real `provisionTestDatabase()` and
`disposeTestDatabase()` capabilities with a retained branded handle. It verifies the exact
generated target exists after provisioning, injects a bootstrap error before spawn, records
zero spawn calls, preserves `bootstrap injected` when real disposal succeeds, and verifies
that exact target is absent afterward. The source template is only observed read-only before
and after; its session count remains zero. No source-template connection, migration,
termination, or drop is performed by the test.

## Final acceptance commands

```text
bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
61 pass, 0 fail, 406 expect() calls, 6.01s

bun test test/eval-database-isolation.test.ts
17 pass, 0 fail, 137 expect() calls, 5.46s

bun test test/h3-restore-scripts.test.ts
126 pass, 0 fail, 3682 expect() calls, 155.47s

bun test
1050 pass, 1 skip, 0 fail, 9584 expect() calls
Ran 1051 tests across 51 files. [223.42s]

bunx biome check test/test-database-isolation.test.ts \
  test/eval-database-isolation.test.ts test/h3-restore-scripts.test.ts
Checked 3 files in 38ms. No fixes applied.

bash -n scripts/eval-pmb.sh
pass

git diff --check
pass
```

## Runtime and safety evidence

Read-only engineering checks through `.env.engineering` after the final eval run:

```text
native_role=f|t|t
guarded_db_count=0
source_template_activity=0
wrapper/owned-child/test-process residue: none
```

The tests use mocked/local-only providers; no provider-capable eval or egress path was run.

## Range and protected-path proof

Before this report was force-added, the implementation diff from
`4e685e06127e2ed2a5efded951cc933cabe8b6c1` contained exactly the two approved test files.
The protected diff across `bunfig.toml`, package manifests/lock, Make, workflow, `src`,
`scripts`, and `db/migrations` was empty. The report is the only additional implementation
path and is intentionally kept under the approved SDD report location.

## Commit note

This report records evidence only; it is not a self-review or approval. The implementation
must be committed with the exact message `test: prove owned bootstrap cleanup order`, then
sent for fresh Luna advisory and independent Sol binding review at the resulting exact SHA.
