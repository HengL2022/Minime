### Task 6 R2: make owned database teardown authoritative

Start only after the exact final plan commit containing this brief receives fresh Luna
advisory and independent Sol binding PASS. That exact commit is
`TASK6_R2_BLOCKER_RECHECK_PLAN_SHA`, resolved to the same reviewed HEAD in the ledger and
both review verdicts. The earlier lifecycle plan ending at
`85427bd45e7a255eb6ba06825b8ae21d8bb5b4b3` is not an implementation base.

Read the complete Task 6 R2 section and stop conditions in
`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md`, the latest joint Sol binding
failure, the Task 6/6.5/6.75 reports and reviews, and the relevant database ownership code.

Files:
- Modify: `test/support/test-database.ts`
- Modify: `test/test-database-isolation.test.ts`
- Modify: `test/eval-database-isolation.test.ts`
- Modify: `test/fixtures/owned-db-child.ts`
- Modify: `test/setup.ts`
- Modify: `test/m15.roles.test.ts`
- Create:
  `.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-6-r2-cleanup-race-report.md`

You are not alone in the repository. Preserve all other work and untracked review
artifacts. Do not change application source, migrations, scripts, packages/lock,
`tsconfig.json`, Make, workflow, grants, privacy/egress behavior, protected data/settings,
or any frozen range.

First add the plan's deterministic blocker-cycle REDs with an injected clock: blocker
disappears; 20-cycle persistence; foreign/hidden PID changes; blocker→error/malformed;
autovacuum/parallel/logical/custom/unknown/mixed persistence; ordinary-drop `55006` sharing
the same cycle budget; duplicate PID and termination SQL/protocol/result-integrity failure;
clock rejection after a blocker or `55006`; and non-`55006` ordinary-drop failure. Bind 20
complete snapshots, 19 maximum `delay(100)` calls, and no wall-clock sleep in fakes. Assert
exact snapshot/delay/termination/drop counts and no later call after any terminal error.
The exact trace is fence → complete snapshot → blocker/delay/fresh snapshot OR zero
blockers/eligible termination/ordinary drop. Any blocker makes termination/drop
unreachable in that cycle.

Cover both ownership proofs: a retained created-by-this-process branded handle, and the
module-internal post-clone/pre-mint rollback proof consisting only of the same immutable,
revalidated generated plan plus the local `cloneSucceeded === true` fact. The latter must
share the same private teardown helper, mint or forge no handle, accept no arbitrary name,
and never infer ownership from `exists()`. Prove extension-assertion and
provisioning-admin-close rollback, clone-rejection/collision negative behavior, and fixed
cleanup-error precedence.

Implement the exact-target `ALLOW_CONNECTIONS=false` fence and query only PID, role, and
backend type. Structurally exact rows with NULL role/type are valid blocker evidence.
Eligible clients are only same-role `client backend`; every foreign, hidden, autovacuum,
parallel, logical, custom, unknown, or mixed row is a blocker. PID disappearance/change
proves nothing. Hold one reserved admin connection through all cycles. On a blocker, perform
no termination/drop and reclassify after the injected delay. After a complete zero-blocker
snapshot, terminate only eligible client PIDs with a positive server timeout, then use
ordinary `DROP DATABASE`. A well-formed false may proceed to ordinary drop; SQL/protocol/
result-integrity failure may not.

Remove all force-drop constants/state and every `WITH (FORCE)` path. A `55006` ordinary-drop
result consumes the current cycle, delays unless it was cycle 20, and requires a completely
fresh snapshot. Successful ordinary drop alone marks disposal. Post-drop admin-close
failure leaves a minted handle disposed and exposes only the fixed cleanup error; any
pre-drop failure leaves it fenced and retryable.

Preserve the observed foreign hidden-field row as a blocker. Add the plan's test-owned
closer registry in setup and register M15's memoized read-only pool closer immediately
after pool construction. A drain snapshots registrations, safely invokes every snapshot
entry once despite synchronous throws or asynchronous rejections, and shares one promise
across repeated/concurrent calls. Unregister before the snapshot removes an entry;
unregister after drain starts is idempotent and cannot alter the snapshot; late registration
fails fixed/content-free. Store distinct registration records so registering the same
function twice does not deduplicate either registration. Use `Promise.allSettled`, not a
fail-fast aggregate. The M15 local hook and registry may both invoke one memoized wrapper,
but its underlying `ro.end` runs once and every path normalizes close failure.

Prove both pool-close phases and disposal are attempted under failure and cleanup failure
takes fixed precedence over a bootstrap error. Preserve the forensic exception:
`MINIME_KEEP_TEST_DATABASE=1` drains both pool layers, skips disposal only for a
process-created database, and prints only its validated guarded name. Do not rely on hook
order, caller sleeps/retries, broader stats visibility, or foreign termination; the only
teardown wait is the injected 20-cycle blocker/`55006` budget.

Keep the exported `bootstrapTestDatabase()` fake-handle seam from draining the process
singleton: inject its drain dependency with a fresh/no-op default for existing
`test/migration-context.test.ts` callers. The retained top-level bootstrap, normal
`afterAll`, and signal cleanup must explicitly receive the singleton drain. Prove fake
cleanup cannot make later registration fail and production cleanup cannot omit the drain;
do not edit `test/migration-context.test.ts`.

Do not add Bun `--rerun-each` support to setup. Bun 1.3.13 keeps preload/application modules
cached while replaying only the entrypoint and exposes no supported final-repeat JS state.
Do not inspect `ps`/the OS command line, hardcode a repeat count, defer normal setup
teardown, swallow late registration, or reopen M15 per test. The repetition gate is ten
ordinary fresh-process `bun test test/m15.roles.test.ts` runs in an isolated fail-fast
subshell; any one failure fails the gate. Each process owns one shared M15 pool and one
normal setup lifecycle.

Add the real foreign-role fence/retry proof and the bounded abrupt-child wrapper proof.
The first deliberate foreign disposal consumes its bounded cycle budget and fixed-fails
without terminating the still-live PID. After awaited foreign close, retry through a fresh
admin connection and allow any distinct anonymous PID to disappear only through bounded
reclassification. Never infer its type or identity.
The abrupt fixture must set the fixed application name through postgres.js options and emit
only its PID, current role/backend type, fixed application name, guarded name, and
migration/extension facts before `process.exit(0)`. Never emit query text, URLs,
credentials, source names, or row content.

Run every focused/full/typecheck/format/offline/safety/scope/no-egress gate in the plan.
After each real/full gate prove guarded database and source activity zero, native role
`f|t|t`, and no attributable process. Write the dedicated report and commit exact message
`test: make owned database teardown authoritative`.

Stop rather than expanding scope on a blocker that persists through 20 cycles in a required
real gate, prepared transaction, slot/subscription, required grant/application change, any
remaining force-drop path, PostgreSQL 16 incompatibility, sensitive output, failed gate,
protected-path change, provider egress, or residue.
