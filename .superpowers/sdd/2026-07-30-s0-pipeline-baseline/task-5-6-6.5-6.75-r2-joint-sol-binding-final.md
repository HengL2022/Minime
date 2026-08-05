# Task 5 / 6 / 6.5 / 6.75 / R2 joint Sol binding final

## Binding verdict

**PASS**

- Spec compliance: **PASS**
- Code quality: **PASS**
- Critical: **0**
- Important: **0**
- Minor: **0**

This is the independent binding Sol review. It covers the complete named ranges, the exact
Task 6 R2 candidate, the fresh Luna first-pass evidence, the three required independent
exact-candidate full-suite runs, and the combined runtime/typecheck acceptance gate. It is
not an implementation report and does not approve a moving branch.

## Exact identity

- Immutable plan/spec SHA:
  `4df61a330264d6dce4a2d751b0f8505000dbb48f`
- Reviewed candidate SHA:
  `dc3848fa7f0f0e9e957d0c7f7df883b2017e8161`
- Reviewed candidate tree:
  `383476fbd7f01d514df106013bf200e3f88e41f0`
- Task 6 R2 reviewed range:
  `4df61a330264d6dce4a2d751b0f8505000dbb48f..dc3848fa7f0f0e9e957d0c7f7df883b2017e8161`
- Task 5 updater bridge:
  `09fcdb459a6dbba86478acc77fc9c6ded3612802..06e1e1fc5fc81d96e9078decf31224a543a5880d`
- Original Task 6:
  `72f7c198763278ad83d0ffbc51681d1c4ae66f02..3c3f196e71d3eec977a3d7c451da85f6282e78be`
- Frozen Task 6.5:
  `4520380f9f41a8507982d7783668f3155013a020..e210235ea9ab7b6c368420ad25e82b3f24d6d81b`
- Frozen Task 6 I-1:
  `4e685e06127e2ed2a5efded951cc933cabe8b6c1..fa8ecc3e7f8025439ebbfbb7ef969a7e66064aac`
- Frozen Task 6.75:
  `39d42b9d9ebdee8bc56f96b90542aed42336d8ab..161602601ae3695af9b1af91b06d530cb205d9c5`

The R2 range contains exactly the authorized report and six TypeScript test/harness paths:

```text
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-6-r2-cleanup-race-report.md
test/eval-database-isolation.test.ts
test/fixtures/owned-db-child.ts
test/m15.roles.test.ts
test/setup.ts
test/support/test-database.ts
test/test-database-isolation.test.ts
```

The protected diff over `bunfig.toml`, `package.json`, `bun.lock`, `tsconfig.json`,
`Makefile`, `.github/workflows/eval.yml`, `src`, `db/migrations`, and
`scripts/eval-pmb.sh` is empty. Task 5 production paths remain unchanged after its rebound
HEAD. The unrelated pre-existing untracked `.superpowers/s0-template-*` files were
preserved and are outside the reviewed range.

## Binding review

### Exported teardown bypass and private authority

The prior Important finding is closed. `TestDatabaseAdmin` no longer exports an optional
`teardown` operation (`test/support/test-database.ts:79-88`). Authoritative default admins
are identified only by the module-private `WeakSet` at `:90`, branded immediately before
return at `:563`, and dispatched through the module-private helper at `:179-188`.
Therefore an injected runtime `teardown` property cannot replace or bypass the
authoritative ordinary-drop cycle. The unbranded `terminate` then `drop` sequence remains
only as the frozen dependency seam for injected test doubles; it cannot mint the private
default-admin identity. The regression at
`test/test-database-isolation.test.ts:342-372` checks both the public interface and the
runtime-property bypass.

Ownership is not inferred from database existence. Cleanup revalidates the immutable
generated plan, and pre-mint rollback additionally requires the local `cloneSucceeded`
fact. Forged handles, caller mutation, clone rejection, and same-name collision therefore
cannot acquire cleanup authority.

### Malformed username ordering

The prior Minor finding is closed. The admin URL is parsed and its username decoded inside
the fixed-error guard before `factory()` or `reserve()` runs
(`test/support/test-database.ts:333-350`). The `%ZZ` regression proves
`test_database_invalid` with zero factory, reserve, and pool-end calls
(`test/test-database-isolation.test.ts:1626-1653`). Raw URI exceptions cannot escape and
there is no pre-validation pool to leak.

### Authoritative bounded teardown

The default adapter:

1. validates the guarded generated name and fences the exact target with
   `ALLOW_CONNECTIONS false`;
2. obtains a complete snapshot containing only `pid`, `usename`, and `backend_type`;
3. treats only positively classified current-role `client backend` rows as eligible;
4. treats foreign, hidden/NULL, background, logical, custom, unknown, duplicate, changed-PID,
   and mixed activity as blockers;
5. rechecks target, role, and backend type in termination SQL and validates the complete
   result;
6. issues only ordinary `DROP DATABASE` after a complete safe snapshot;
7. gives SQLSTATE `55006` a fresh bounded cycle; and
8. stops after exactly 20 complete snapshots and at most 19 100-ms delays.

The implementation is at `test/support/test-database.ts:362-481`. No
`WITH (FORCE)`, force-drop, `pg_read_all_stats`, `client_addr`, `application_name`, or
query-text inspection path exists. Failed pre-drop disposal restores the branded handle to
`live` for a later retry; successful drop marks it disposed before connection-close
handling (`:582-602`). The focused tests cover blocker disappearance/persistence,
same-handle retry, PID changes, snapshot and protocol failures, every ineligible backend
class, termination-result integrity, SQLSTATE `55006`, ordinary-drop failure, and the
20-cycle/19-delay bound.

### Process and auxiliary resource lifecycle

The auxiliary closer registry stores distinct registrations, freezes at drain start,
snapshots once, settles every closer with `Promise.allSettled`, and shares one drain promise
(`test/setup.ts:23-53`). Cleanup order is auxiliary closers, application pool close, then
branded database disposal, with every phase attempted and the exact keep-forensics exception
retained (`:85-125`). Normal `afterAll`, bootstrap failure, `SIGINT`, and `SIGTERM` all
receive the same retained-handle cleanup (`:127-175`).

M15 registers its read-only pool closer immediately after pool construction and before the
first query. Its local `afterAll` and global registry share one memoized close operation
(`test/m15.roles.test.ts:29-71`). The design does not inspect OS command lines, hardcode a
runner repeat count, defer normal teardown, or reopen M15 per test.

The real eval coverage includes an abrupt child that exits with its SQL connection open, a
foreign `minime_engineer_ro` blocker that makes the first disposal fail closed and the
same branded handle succeed after the blocker closes, bootstrap failure, nonzero child,
signals, keep-forensics, and simultaneous wrappers. Output is restricted to bounded test
identity fields; it does not expose URLs, credentials, query text, or user content.

## Fresh acceptance evidence

The required independent exact-HEAD full-suite runs all exited naturally at
`dc3848fa7f0f0e9e957d0c7f7df883b2017e8161`:

```text
executor:
1079 pass / 1 skip / 0 fail / 9781 expect
1080 tests across 51 files; 200.57s

fresh Luna first pass:
1079 pass / 1 skip / 0 fail / 9781 expect
1080 tests across 51 files; 196.45s

independent Sol binding:
1079 pass / 1 skip / 0 fail / 9781 expect
1080 tests across 51 files; 204.29s
```

The Luna evidence and advisory `C0/I0/M0` verdict are recorded in
`task-6-r2-luna-implementation-rereview.md`. That advisory was considered but not
substituted for the Sol code review or fresh Sol commands.

Additional fresh Sol evidence:

```text
bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
90 pass / 0 fail / 604 expect

bun test test/update-bootstrap.test.ts test/update.test.ts test/backup.test.ts
19 pass / 0 fail / 63 expect

bunx --package typescript@5.9.3 tsc --noEmit --pretty false
exit 0; no diagnostics

bunx biome check <six changed TypeScript files>
Checked 6 files; no fixes applied

bash -n scripts/eval-pmb.sh
exit 0

git diff --check
exit 0

static safety rg over test/support/test-database.ts
no matches
```

Immediate final residue/posture evidence:

```text
candidate HEAD: dc3848fa7f0f0e9e957d0c7f7df883b2017e8161
native role minime: false|true|true
generated guarded databases: 0
source-template activity: 0
wrapper/owned-child/bun-test process residue: none
```

No provider-capable eval or egress command was run during this binding review.

## Frozen neighboring gates

Task 5's previously adjudicated Critical is recorded `CLOSED / PASS` at rebound HEAD
`06e1e1fc5fc81d96e9078decf31224a543a5880d` in
`task-5-critical-sol-adjudication-rereview.md`. Its production paths are unchanged at the
current candidate, and the fresh 19-test updater/backup bridge is green.

Task 6's original isolation range and I-1 closure remain unchanged except for the scoped R2
correction reviewed above. Task 6.5 remains the single explicit 30-second file-level default
for the H3 subprocess integration file, without retries or a global project timeout.
Task 6.75 retains its authorized harness-only/type correction scope, and the current full
compiler graph passes TypeScript 5.9.3 with no diagnostics.

## Findings

### Critical

0.

### Important

0. The earlier exported/custom teardown bypass is closed by the private WeakSet authority
boundary and regression evidence; no downgrade is used.

### Minor

0. The earlier malformed-username ordering/leak issue is closed by pre-factory decoding and
fixed-error regression evidence; no downgrade is used.

## Final labels and stop conditions

- **Task 5 updater bridge PASS**
- **Task 6 PASS**
- **Task 6.5 PASS**
- **Task 6.75/typecheck readiness PASS**
- **Task 6 R2 PASS**
- **Combined acceptance PASS**
- **Critical 0 / Important 0 / Minor 0**

No binding stop condition fired: no persistent real-gate blocker, prepared/logical activity,
force-drop path, unsafe blocker-to-drop transition, protected-path change, provider egress,
full-gate failure, database/process residue, role/grant change, sensitive-content dependency,
or PostgreSQL-16 incompatibility was found.

Task 7 remains gated only on recording the closure-only ledger/review-artifact commit at
this exact candidate lineage. This verdict does not bind any later code change.
