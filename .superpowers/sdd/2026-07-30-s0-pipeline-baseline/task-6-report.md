# Task 6 report: isolate automated database processes

Status: TASK 6 GREEN; authoritative unscoped gate BLOCKED by unchanged H3 timeouts

Task 6 base: `72f7c198763278ad83d0ffbc51681d1c4ae66f02`
Luna-remediation base: `1b64b62e3710be40d6928717580ba1e7521da083`

## RED and recovery

- The amended wrapper/environment RED test was added first and failed because
  `runWithOwnedTestDatabase()` left `DATABASE_URL` set to the fake generated target
  `minime_test_323_cccccccccccc` after completion.
- The stranded overlapping-run artifact was validated before recovery:
  `minime_test_58863_e45ef96db144|owner=minime|sessions=0`; PID `58863` was absent.
  It was removed once through the Task 3 `createDefaultTestDatabaseDeps()` adapter
  (`terminate()` then `drop()`), and a catalog query returned `0` rows afterward.
- No shared, live, legacy, or source-template database was targeted. Subsequent catalog
  checks after every real gate returned zero `minime_test_*` children, with no Bun test or
  wrapper process left running.

## Luna remediation RED/GREEN

- The concurrent disposal reproduction used five real pairs of executable wrappers; rounds 3
  and 5 returned one `test_database_cleanup_failed` and left only their generated, owner=`minime`
  targets with zero sessions. The exact names were catalog-validated and then recovered through
  `createDefaultTestDatabaseDeps()` (`terminate()` then `drop()`); the final guarded catalog count
  was `0`. Instrumentation also observed a live target client backend (`usename=minime`,
  `backend_type=client backend`) and confirmed same-role termination succeeds.
- New adapter RED tests first failed with `activityChecks` `0` instead of `2` and with raw
  SQLSTATE `55006` (`busy`) instead of a bounded fixed cleanup error. GREEN now polls fresh
  `pg_stat_activity`, terminates only `current_user` client backends, retries the zero-to-drop
  race a bounded number of times, and maps exhausted or unexpected cleanup failures to
  `test_database_cleanup_failed`.
- Ten subsequent concurrent real wrapper pairs (20 wrappers) returned `rc_a=0 rc_b=0` for every
  pair: `pair_failures=0 final_guarded_rows=0`.
- The real child now verifies both cloned extensions and reports `extensions=["pgcrypto","vector"]`.
  Sentinel tests assert that the source URL is absent from child environment, unselected aliases,
  argv, stdout, stderr, and parser-failure output. The keep-forensics case validates the printed
  target against the generated-name grammar, owner `minime`, and zero sessions before recovering
  only that exact target through the adapter.
- An executable Bun wrapper harness covers bootstrap, spawn, disposal, and spawn-plus-disposal
  failures, checks cleanup precedence and environment restoration, and injects SIGINT/SIGTERM
  only after a condition-based `READY` marker during bootstrap/spawn. Real SIGINT and SIGTERM
  wrapper cases also dispose their generated targets.

## R1-I1 timing remediation

- A focused reproduction under host contention measured real wrapper tests at the Bun default
  5-second budget: the simultaneous-wrapper case timed out at `5002.07ms`; a subsequent
  eval-only run timed out real child cases and emitted a `CONNECT_TIMEOUT localhost:5432` hook
  error. The host had 942 processes, 6,927 threads, and load average 11.26; several orphaned
  `btplatform-verify` PostgreSQL servers were present. This was not a Task 6 assertion failure.
- TDD RED: the new source-contract test failed because the real integration cases had no named
  timeout constant/options. GREEN adds `REAL_INTEGRATION_TIMEOUT_MS = 30_000` only to the eight
  real DB/subprocess eval cases; fake/static tests and global configuration are unchanged.
  The keep-forensics test also uses a bounded 100-attempt × 50ms idle poll after one observed
  transient `sessions=1` race, before validating and recovering the exact target.
- Post-change focused stress gate:

  ```text
  bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
  58 pass, 0 fail, 390 expect() calls, 5.65s
  ```

- Three timed-out-run artifacts were validated before recovery: `minime_test_28266_211af78a0c6f`,
  `minime_test_eval_search_24502_224505f92d8c`, and
  `minime_test_eval_search_36616_6d0acf82c53c`; each matched the guarded grammar, had
  `owner=minime`, `sessions=0`, and its originating PID was absent. The exact names were removed
  through the application-owner adapter only; its verification returned `remaining=[]`. A later
  keep-forensics assertion race left `minime_test_eval_search_70055_9fdc8d25d309`; it was likewise
  owner/session-validated and adapter-recovered, with no remaining guarded rows.

- The solitary authoritative unscoped run remained red only in unchanged H3 paths:

  ```text
  bun test
  1016 pass, 1 skip, 31 fail, 9568 expect() calls, 1048 tests across 51 files, 471.76s
  ```

  All 31 failures were H3 subprocess timeout cases (individual elapsed times exceeded the
  unchanged 5-second H3 budget); no Task 6 test failed. No H3 path or H3 test timeout was
  changed. The run left zero `minime_test_*` databases and no Task 6 wrapper/test processes.
  This is an out-of-ledger H3 acceptance blocker requiring a binding plan amendment or owner
  waiver; it is not masked by the Task 6 timeout increase.

## GREEN implementation

The wrapper snapshots and restores `DATABASE_URL`, all approved eval aliases, and
`MINIME_TEST_DATABASE_URL` in its outer `finally`. Owned assignment, dynamic migration
bootstrap, parent `closeDb()`, child spawn, signal forwarding, and branded disposal order
remain unchanged. The new behavioral test covers success, child nonzero, bootstrap failure,
spawn failure, disposal failure, and inherited external rejection state.

## Exact acceptance commands and results

```text
bun test test/test-database-isolation.test.ts --test-name-pattern "restores parent-owned environment|sets the owned URL|migration and parent close|rejects inherited external"
4 pass, 0 fail, 47 expect() calls

Historical pre-remediation gate at the Task 6 base:

bun test test/h3-restore-scripts.test.ts test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
176 pass, 0 fail, 4013 expect() calls, 161.98s

bun test test/test-database-isolation.test.ts --test-name-pattern "signal cleanup|owned child|bootstrap|template|external|rollback"
12 pass, 0 fail, 100 expect() calls

bun test test/eval-database-isolation.test.ts
16 pass, 0 fail, 130 expect() calls

bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
58 pass, 0 fail, 390 expect() calls

bun test test/h3-restore-scripts.test.ts
126 pass, 0 fail, 3682 expect() calls

make verify-m0-offline
PASS postgres reachable; PASS vector; PASS pgcrypto; PASS mocked Ollama/providers

concurrent `bun test test/m1.schema.test.ts` and `bun test test/m14.extract-validate.test.ts`
m1: 16 pass, 0 fail, 107 expect() calls; m14: 10 pass, 0 fail, 53 expect() calls

bun test
1016 pass, 1 skip, 31 fail, 9568 expect() calls, 1048 tests across 51 files, 471.76s
```

The full-suite failures were unchanged H3 subprocess timeout cases. A prior standalone H3 gate
completed 126/126, but the authoritative unscoped command above is not green and remains blocked;
no H3 path was changed here:

```text
bun test test/h3-restore-scripts.test.ts --test-name-pattern "restore-pitr validation failure|pre-promote dump and retention stay inside"
2 pass, 0 fail, 76 expect() calls
```

The full run left no generated test databases or Task 6 wrapper processes. The timeout behavior
is an environmental/H3 acceptance concern for the unchanged 5-second H3 test budget.

## Contract/static evidence

- Native role command returned exactly `f|t|t` for `rolsuper|rolcreatedb|rolcreaterole`.
- Required Make dry-runs showed only the wrapper, approved labels/aliases, and exact child
  argv; actual `make eval-snapshot ROUND=` returned exit `2` with the usage line before any
  wrapper invocation.
- `bunx biome check` on the four changed TypeScript files: pass, no fixes applied.
- `bash -n scripts/eval-pmb.sh`: pass.
- `git diff --check`: pass.
- Workflow/eval static assertions passed in `test/eval-database-isolation.test.ts`, including
  `postgres` bootstrap, runtime `minime`, `f|t|t`, template-only extensions, and no
  `minime_eval*` provisioning.

## Changed paths

Approved Task 6 paths only:

`.github/workflows/eval.yml`, `Makefile`, `scripts/eval-pmb.sh`,
`scripts/with-test-database.ts`, `test/setup.ts`, `test/support/test-database.ts`,
`test/test-database-isolation.test.ts`, `test/eval-database-isolation.test.ts`,
`test/fixtures/owned-db-child.ts`, and `test/fixtures/test-db-probe.test.ts`.

The existing untracked `.superpowers/` review artifacts were preserved and are not part of
the implementation scope.

## Commit note

The exact requested commit message is `test: isolate automated database processes`. Commit
identity and approval must be established by the parent/reviewer; this report is evidence,
not a self-review or approval.
