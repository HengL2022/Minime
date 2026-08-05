# Task 5 report — safe first-hop updater rerun

BASE: `09fcdb459a6dbba86478acc77fc9c6ded3612802`
HEAD: the commit containing this report; exact HEAD is recorded by the parent review package.

## RED

The required command was run before the implementation:

```text
bun test test/update-bootstrap.test.ts test/update.test.ts test/backup.test.ts
```

Result: `2 pass`, `5 fail`, `1 error`, `Ran 7 tests across 3 files.` The generated transition tests failed against the pre-change updater and the backup tests reported the missing `preUpdateSnapshot` export. This was the expected RED checkpoint.

The review strengthening RED was then run against the old harness:

```text
bun test test/update-bootstrap.test.ts test/update.test.ts test/backup.test.ts
15 pass, 1 fail, 51 expect() calls
```

The failure was the required database ledger assertion: the old synthetic Commit-B append left the guarded `schema_migrations` count at `0`.

The libpq-poisoning RED regression was then run against the inherited-environment harness:

```text
bun test test/update-bootstrap.test.ts --test-name-pattern 'poisoning'
0 pass, 1 fail
test_database_sql
```

The failure occurred while the vulnerable parent helper inherited a closed-loopback `PGSERVICE`/`PGSERVICEFILE` plus `PGHOSTADDR`.

## GREEN

The generated transition repository contains a bare origin, a minimal Commit A updater, and a checked-out Commit B guard/CLI with a transactional no-op `021_runtime_app_role.sql`. Controlled Git/Bun delegates real fetch, pull, and the checked-out Commit B CLI.

Observed traces:

```text
fetch, pull, install, backup_failed, migrate_refused
preflight, backup_failed
preflight, backup, fetch, pull, install, migrate:update:taken, verify
preflight, backup, fetch, pull, install, migrate:update:unconfigured, verify
```

The checked-out Commit-B CLI now reads the checked-out SQL body and executes it with `psql` inside `BEGIN`/`COMMIT`, inserting the ledger row in that same transaction against the inherited guarded loopback test database. Both the parent helper and generated CLI use a hermetic libpq environment with only bounded locale/PATH, `PGCONNECT_TIMEOUT=3`, and validated loopback `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`; inherited service, host-address, options, and other routing variables are excluded. Each SQL call first asserts `current_database()` equals the exact guarded name on that same connection. The first invocation exits 50 without a ledger. The checked-out rerun executes `021_runtime_app_role.sql`; a third invocation leaves the database ledger count at exactly one. A malformed test-only SQL body rolls back and leaves the ledger count at zero. Backup outcomes are `{ kind: "taken" }`, `{ kind: "unconfigured" }`, and `{ kind: "failed" }`; CLI exit codes are 0, 3, and 1 respectively. Status output is one fixed content-free `backup:pre-update <outcome>` line.

## Verification

```text
bun test test/update-bootstrap.test.ts test/update.test.ts test/backup.test.ts
19 pass, 0 fail, 63 expect() calls

bun test test/update-bootstrap.test.ts test/update.test.ts test/backup.test.ts test/migration-context.test.ts
53 pass, 0 fail, 111 expect() calls

bun test test/h3-data-root.test.ts test/m5.decisions.test.ts
22 pass, 0 fail, 123 expect() calls

bash -n scripts/update.sh
exit 0

bunx --no-install biome check src/pipeline/backup.ts src/cli.ts test/backup.test.ts test/update.test.ts test/update-bootstrap.test.ts
Checked 5 files; no fixes applied.

git diff --check
exit 0
```

The combined neighboring bridge (`update-bootstrap`, `update`, `backup`, `migration-context`, `h3-data-root`, and `m5.decisions`) ended with `75 pass, 0 fail, 234 expect() calls`; the final guarded scratch database count was `0`. The poisoning regression passed with inherited `PGSERVICE`, `PGSERVICEFILE`, and `PGHOSTADDR`, and bracketed `[::1]` normalization is covered.

Binding Sol Minor closure: the legacy first-hop test now asserts `scratchMigrationCount() === 0` immediately after the exit-50 refusal trace, using the guarded PostgreSQL ledger on the same validated connection. The prior filesystem-surrogate assertion and its unused `existsSync` import were removed.

A before/after PostgreSQL catalog check around the focused bridge suite initially reported:

```text
scratch DB cleanup: no new guarded databases
```

The initial RED process had PID `99661` in its generated run token and aborted during module loading on the missing `preUpdateSnapshot` export, before Bun could run the normal `afterAll` cleanup. That left the exact generated database `minime_test_99661_f4f2ae9974d1` with zero sessions. It was validated as owned by `minime` and removed through the application-owner `dropdb` path. Evidence:

```text
removed exact abandoned RED database: minime_test_99661_f4f2ae9974d1
final exact-name count: 0
```

The focused bridge was rerun after removal and ended with:

```text
19 pass, 0 fail, 63 expect() calls
final guarded scratch database count: 0
```

The strengthened backup-failure bridge asserts exit `1`, empty stderr, exactly one fixed `ERROR:` line and one fixed `FIX:` line, and the trace remains `preflight, backup_failed` with no Git, install, or migration events.

## Changed paths

- `AGENTS.md`
- `scripts/update.sh`
- `src/cli.ts`
- `src/pipeline/backup.ts`
- `test/backup.test.ts`
- `test/update-bootstrap.test.ts`

The CLI pre-update command bypasses unrelated Ollama preflight so its contract remains exact even with an invalid provider URL; a closed-port/invalid-provider probe returned `backup:pre-update unconfigured` and internal exit `3`.

No frozen `test/fixtures/update-before-s0.sh` was created. The commit is:

```text
`fix: bootstrap fail-closed updates before migration 021`
```
