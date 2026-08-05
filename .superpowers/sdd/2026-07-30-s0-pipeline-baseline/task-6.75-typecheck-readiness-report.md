# Task 6.75 strict-typecheck readiness report

Status: implementation GREEN; fresh Luna advisory and independent Sol binding review remain
external to this report.

## Binding identity and exact scope

- `TASK675_PLAN_SHA`: `39d42b9d9ebdee8bc56f96b90542aed42336d8ab`
- implementation range: `TASK675_PLAN_SHA..TASK675_IMPLEMENTATION_SHA`
- requested commit message: `test: make S0 harnesses typecheck-ready`
- implementation paths: `scripts/with-test-database.ts`,
  `test/eval-database-isolation.test.ts`, `test/fixtures/owned-db-child.ts`,
  `test/fixtures/test-db-probe.test.ts`, `test/update-bootstrap.test.ts`, and this report

No package manifest/lock, `tsconfig.json`, Make, workflow, application source, migration,
PMB script, protected data/settings, database policy, or privacy/egress path changed.

## Preserved RED evidence

At the exact plan HEAD, the command below produced the required 26 TypeScript 5.9.3
diagnostics and exited 2:

```text
bunx --package typescript@5.9.3 tsc --noEmit --pretty false
1 scripts/with-test-database.ts
13 test/eval-database-isolation.test.ts
2 test/fixtures/owned-db-child.ts
2 test/fixtures/test-db-probe.test.ts
8 test/update-bootstrap.test.ts
EXIT=2; total=26
```

Before moving any timeout option, the strengthened named-contract test enumerated all nine
real integration cases (including bootstrap failure), isolated each named block, and required
the timeout object immediately before the outer `);` in Bun's third argument position:

```text
bun test test/eval-database-isolation.test.ts \
  --test-name-pattern 'real wrapper integration cases declare an explicit bounded timeout'
0 pass, 16 filtered out, 1 fail, 4 expect() calls
```

The failure was solely the existing second-position timeout contract; no runtime test body was
changed before this RED run.

## Bounded corrections

- Explicitly reject an undefined `--database-env` candidate before the existing allowlist.
- Type `waitForHarnessReady` from `ReturnType<typeof runWrapperHarness>`.
- Move all nine existing 30-second timeout objects to Bun's declared third argument.
- Use `createDefaultTestDatabaseDeps()` for both real dependency cases.
- Use one-row tuple generics for the four fixture query destructures.
- Narrow the updater driver result to `Bun.SyncSubprocess<"pipe", "pipe">`.

These are type-only or declaration-position corrections. No `any`, broad casts, non-null
assertions, suppressions, exclusions, compiler weakening, retry, timeout-bound change, or
behavior/error/output contract change was introduced.

## GREEN and focused behavior

```text
bun test test/eval-database-isolation.test.ts \
  --test-name-pattern 'real wrapper integration cases declare an explicit bounded timeout'
1 pass, 16 filtered out, 0 fail, 28 expect() calls

bunx --package typescript@5.9.3 tsc --noEmit --pretty false
EXIT=0; 0 diagnostics

bun test test/update-bootstrap.test.ts test/update.test.ts test/backup.test.ts
19 pass, 0 fail, 63 expect() calls

bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
61 pass, 0 fail, 425 expect() calls

bun test test/eval-database-isolation.test.ts
17 pass, 0 fail, 156 expect() calls

bun test test/h3-restore-scripts.test.ts
126 pass, 0 fail, 3682 expect() calls
```

## Complete pipeline and safety gates

```text
make -n verify-m0                           PASS
make -n verify-m0-offline                   PASS
make -n eval-skills ROUND=r1                PASS
make -n optimize-skill SUITE=query ROUND=r1 PASS
make -n eval-snapshot ROUND=                PASS (usage command emitted as expected)
make -n eval-snapshot ROUND=v0.9            PASS
make verify-m0-offline                      PASS (mocked Ollama; guarded target)

bun test test/m1.schema.test.ts             16 pass, 0 fail
bun test test/m14.extract-validate.test.ts  10 pass, 0 fail
bun test                                    1050 pass, 1 skip, 0 fail,
                                             9602 expect() calls, 1051 tests/51 files,
                                             265.11s

bunx --package typescript@5.9.3 tsc --noEmit --pretty false  PASS, 0 diagnostics
bunx biome check [five implementation files]                PASS, no fixes
bash -n scripts/eval-pmb.sh                                 PASS
git diff --check                                            PASS
```

The unscoped suite's only skip is the pre-existing provisioned-machine install E2E test.
All eval paths used mocked/local-only providers; no provider-capable eval or egress path ran.

## Scope, protected paths, and package/config proof

Working-tree implementation names before the report were exactly the five approved source/test
paths. The protected check passed with exit 0:

```text
git diff --exit-code TASK675_PLAN_SHA -- \
  bunfig.toml package.json bun.lock tsconfig.json Makefile \
  .github/workflows/eval.yml src db/migrations scripts/eval-pmb.sh
```

`git diff --exit-code TASK675_PLAN_SHA -- package.json bun.lock tsconfig.json` also passed.
The repeated `bunx` invocations reported `Saved lockfile` but left `bun.lock` byte-identical.
Unrelated untracked `.superpowers/s0-template-*` artifacts were preserved.

## Database, source-template, and process posture

Read-only checks through `.env.engineering` reported:

```text
minime role:             false|true|true  (native role f|t|t)
minime_engineer_ro role: false|false|false
generated guarded DBs:   0
minime_test sessions:    0
```

After the final full suite, no attributable `with-test-database.ts`, `owned-db-child.ts`, or
`bun test` process remained. A transient duplicate H3 launch occurred during tool polling; both
processes exited cleanly, and the final standalone H3 and unscoped-suite runs above were clean.
No source-template connection, migration, termination, or drop was performed by this task.

## Commit note

This report records evidence only and is not a self-review or approval. Commit the approved
implementation with the exact message `test: make S0 harnesses typecheck-ready`, then send the
resulting exact SHA for fresh Luna advisory and independent Sol binding review.
