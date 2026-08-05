# Task 4 report — bootstrap isolated migration contexts

## RED

Added pure parser/ledger tests in `test/migration-context.test.ts` before creating the
production module. The required RED command was:

```text
bun test test/migration-context.test.ts --test-name-pattern "parses|compares"
```

It failed as expected with `Cannot find module '../src/db/migration-context'` (`0 pass, 1
fail, 1 error`). The filtered tests performed no database query or socket connection.

The bootstrap cleanup regression was then added before its seam existed:

```text
bun test test/migration-context.test.ts --test-name-pattern "bootstrap failure"
0 pass, 1 fail, 1 error — Export named 'bootstrapTestDatabase' not found
```

After the expected module-load RED, the generated guarded RED artifact was removed through the
Task 3 application-owner adapter before proceeding.

## GREEN

Implemented the fixed migration-context parser, target guard, schema-ledger comparison, current
schema assertion, and context-aware migration runner. The preload now plans a unique
`minime_test_<pid>_<token>` database, provisions and retains Task 3's branded handle, sets
`DATABASE_URL`, imports migration code dynamically, migrates with `{ kind: "test" }`, and closes
the pool before disposing the handle in normal `afterAll` cleanup. Bootstrap failures now attempt
the same close-then-dispose sequence before rethrowing the original failure. Cleanup is memoized
per retained branded handle so a subsequently executed `afterAll` cannot double-close or
double-dispose it. No shared fallback or signal cleanup was added.

Focused results:

```text
bun test test/migration-context.test.ts --test-name-pattern "parses|compares"
7 pass, 0 fail, 7 expect() calls

bun test test/migration-context.test.ts
34 pass, 0 fail, 48 expect() calls

bun test test/migration-context.test.ts test/m1.schema.test.ts
50 pass, 0 fail, 155 expect() calls

bun test test/h3-data-root.test.ts test/h3-libpq-service.test.ts test/access-boost.test.ts test/install.test.ts
53 pass, 1 skip, 0 fail, 207 expect() calls
```

The closed-port child test uses a valid loopback Ollama URL and a closed database port; bare
`bun run src/cli.ts migrate` exits 50 with only:

```text
ERROR: migration context required
FIX: run make migrate, or rerun make update
```

The child output contains neither `ECONNREFUSED` nor the database URL.

The bootstrap-failure regression provisions a generated branded handle and forces a post-mint
failure; cleanup records close before terminate/drop, and repeated cleanup performs each owned
operation once. The same forced failure on a guarded external handle records only the failure and
close callbacks, with no admin reconnect, terminate, or drop.

## Full gate

```text
bun test
1009 pass, 1 skip, 0 fail, 9317 expect() calls
```

The final static checks were:

```text
bunx biome check src/db/migration-context.ts src/db/migrate.ts src/cli.ts test/migration-context.test.ts test/setup.ts test/helpers.ts test/m1.schema.test.ts test/install.test.ts test/access-boost.test.ts test/h3-data-root.test.ts test/h3-libpq-service.test.ts test/test-database-isolation.test.ts
# Checked 12 files in 24ms. No fixes applied.

bash -n scripts/install.sh
# pass

make -n migrate
# bun run src/cli.ts migrate --context direct

git diff --check
# pass
```

After the focused runs and the unscoped suite, the engineering read-only database check returned
no `minime_test_*` rows, confirming every owned test database was dropped. The one guarded
generated database left by the intentional pre-fix RED module-load abort was removed through the
Task 3 application-owner test-database adapter; the final query again returned no rows.

## Callers and changed scope

- Makefile migration uses `--context direct`.
- Installer migration uses `--context install`.
- Test helpers, M1 idempotency, and preload use `migrate({ kind: "test" })`.
- Seed, onboard, and serve assert the schema is current and report the fixed `make migrate`
  remediation instead of auto-migrating.
- Bare migration CLI parsing is strict and refuses missing, duplicate, unknown, trailing, and
  API-only test context flags. Update contexts require `taken` or `unconfigured` snapshot
  outcomes.

Only the approved Task 4 paths were changed; `test/install.test.ts` and
`test/test-database-isolation.test.ts` were inspected and required no edits. No migration,
dependency, updater, provider, source-role, or Task 6 signal behavior was changed.

## Self-review and commit

Self-review checked target validation before filesystem/ledger access in `migrate`, fixed
content-free context errors, preload import ordering, active guarded-name assertions, clean
normal disposal ordering, bootstrap failure cleanup, and once-only cleanup sharing. The amended
commit is recorded on this branch; parent review remains independent and no approval was
performed here.
