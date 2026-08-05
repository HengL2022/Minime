# S5 System Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the post-stabilization architecture, complexity budget, feature-admission
rules, and release evidence part of the enforced development pipeline.

**Architecture:** A current system contract supersedes the historical M0-M6 build plan
without deleting history. Architecture tests preserve the boundaries established in S1-S4.
Search components with pending evidence receive a deterministic ablation decision, the SQL
repository is split by domain behind its existing facade, and machine-enforced size/subsystem
checks plus a PR template prevent the same scope drift from recurring.

**Tech Stack:** Markdown contracts, Bun filesystem/architecture tests, existing MinimeBench
harness, TypeScript modules, Biome, Make, and GitHub pull-request metadata.

## Global Constraints

- `minime-build-plan.md` and `DECISIONS.md` remain historical records; neither is rewritten
  to pretend later work was part of v1.
- `docs/SYSTEM-CONTRACT.md` becomes the sole current normative contract after its tests and
  owner decision merge.
- No new runtime dependency, search feature, ranking weight, data model, or user-facing tool
  is introduced.
- Repository splitting is behavior-preserving and migration-free.
- Existing imports through `src/db/repo.ts` keep working throughout the split.
- Pending search multipliers are retained only under the explicit ablation threshold below;
  otherwise they default to neutral.
- Complexity checks use fixed committed ceilings, not moving averages or comparison to the
  current branch.
- The final release evidence contains statuses, counts, commands, and commit IDs only—no
  personal data, DSNs, secrets, dumps, or raw test fixtures.

---

### Task 1: Establish a current system contract and PR admission checklist

**Files:**

- Create: `docs/SYSTEM-CONTRACT.md`
- Create: `.github/pull_request_template.md`
- Create: `test/system-contract.test.ts`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `minime-build-plan.md`
- Modify: `docs/GUIDE.md`
- Modify: `DECISIONS.md`

**Contract sections:**

```text
1. Mission and differentiated owner workflow
2. Current invariants I1-I8 and accepted amendments
3. Process topology: stdio MCP, singleton daemon, PostgreSQL, model providers
4. Data/archive/index boundaries and sensitivity tiers
5. Database roles and actor-scoped unlock semantics
6. Cloud routing and egress audit
7. Backup, logical snapshot restore, promotion recovery
8. Supported commands and configuration precedence
9. Authoritative development and release gates
10. Supported scope, non-goals, and open known issues
```

Section 5 explicitly distinguishes an MCP-only agent from arbitrary same-UID local code:
the owner-signed, one-use capability prevents an MCP client from self-unlocking, but
mode-0600 owner files and owner CLI commands are not a boundary against code already
running as the owner's OS account. Do not describe the capability as OS-level
human-presence proof.

Sections 3 and 7 show the dedicated dump-only backup child explicitly: runtime CLI, daemon,
Dream, and update parents own scheduling/lease state but never load `.env.backup`; only the
bounded worker runs `pg_dump` as `minime_backup`. The topology must not imply that the
runtime role can produce a complete dump itself.

The header of `minime-build-plan.md` states that it is the historical v1 implementation
plan and points to the current contract. CLAUDE and AGENTS point to the current contract
first and to decisions for history.

**PR template checkboxes:**

```markdown
- [ ] Scope is one independently reviewable milestone.
- [ ] I1-I8 impact is stated; privacy-sensitive changes have invariant review.
- [ ] RED test was observed before implementation.
- [ ] `make verify-offline` passes.
- [ ] `make verify` passes before merge.
- [ ] Migration/operations rollback is documented, or marked not applicable with reason.
- [ ] New subsystem/weight has a committed eval and states what it replaces.
- [ ] No tier-0 content, DSN, secret, path, or personal fixture enters logs/artifacts.
- [ ] Docs and `docs/SUBSYSTEMS.md` match shipped behavior.
```

- [ ] **Step 1: Write contract-reference and drift tests**

Assert CLAUDE/AGENTS/README point to `docs/SYSTEM-CONTRACT.md`; the historical plan no longer
claims sole current authority; the contract names all registered MCP tools by reading
`ALL_TOOLS`; commands/topology match Makefile/CLI; and no documentation claims WAL PITR or
that stdio `serve` owns watchers.

- [ ] **Step 2: Prove the test is red**

```bash
bun test test/system-contract.test.ts
```

- [ ] **Step 3: Write the complete contract and PR template**

Use only behavior proven by S0-S4. Open issues explicitly include multi-entity capture
splitting, fuzzy organization deduplication, WAL PITR, and any search subsystem whose
ablation remains pending during this task.

- [ ] **Step 4: Record source-of-truth decision**

Append the owner-approved decision making `docs/SYSTEM-CONTRACT.md` current and preserving
the v1 plan/decisions as history.

- [ ] **Step 5: Run docs/contract gates and commit**

```bash
bun test test/system-contract.test.ts test/subsystems.test.ts
make check-subsystems
git add \
  docs/SYSTEM-CONTRACT.md .github/pull_request_template.md \
  test/system-contract.test.ts CLAUDE.md AGENTS.md README.md \
  minime-build-plan.md docs/GUIDE.md DECISIONS.md
git commit -m "docs: establish the current minime system contract"
```

---

### Task 2: Resolve pending search multipliers with a committed ablation

**Files:**

- Create: `scripts/eval-search-ablation.ts`
- Create: `test/search-ablation.test.ts`
- Create: `fixtures/qrels/subsystem-ablation.ndjson`
- Create: `docs/benchmarks/trust-stabilization-search-ablation.md`
- Modify: `src/search/hybrid.ts`
- Modify: `src/search/eval.ts`
- Modify: `Makefile`
- Modify: `docs/SUBSYSTEMS.md`
- Modify: `DECISIONS.md`

**Evaluation seam:**

```ts
export interface SearchTuning {
  accessBand: number;
  notesBoost: number;
}

export const DEFAULT_SEARCH_TUNING: Readonly<SearchTuning>;

export async function hybridSearch(
  options: HybridSearchOptions & { tuning?: SearchTuning },
): Promise<Hit[]>;
```

Production defaults remain the current `0.05` and `1.5` until the ablation is scored.

The runner executes the same sealed fictional corpus for:

```text
baseline: accessBand=0.05, notesBoost=1.5
no-access: accessBand=0, notesBoost=1.5
no-notes: accessBand=0.05, notesBoost=1
neutral: accessBand=0, notesBoost=1
```

The dedicated corpus contains primary/compiled pairs and released `get_context` access
events, so both multipliers can change ranking. It never uses owner data.

**Retention threshold, applied independently:**

- retain a multiplier only if it improves overall hit@1 by at least `0.01`;
- no evaluation area may lose more than `0.03` hit@3;
- results must be deterministic across three mock runs.

If a multiplier fails, its production default becomes neutral (`1` for notes, `0` for
access). The scorecard records the exact outcome; no discretionary override is permitted in
this task.

- [ ] **Step 1: Write seam, determinism, and threshold tests**

Assert all four arms use identical queries/qrels, three runs produce identical scores, both
features can alter at least one planted rank, and threshold selection returns the declared
production tuning.

- [ ] **Step 2: Prove tests are red**

```bash
bun test test/search-ablation.test.ts
```

- [ ] **Step 3: Implement the explicit tuning seam and runner**

Do not read tuning from unvalidated arbitrary environment in normal runtime. Only the eval
passes an override.

- [ ] **Step 4: Run and commit the scorecard**

```bash
make eval-search-ablation
bun test test/search-ablation.test.ts
make eval-search
```

Expected: scorecard contains all four arms, per-area deltas, deterministic-run hashes, and
the mechanically selected defaults.

- [ ] **Step 5: Apply the selected defaults and update subsystem evidence**

Update comments and rows from `eval-calibration pending` to either proven retained or
neutralized with the committed scorecard link.

- [ ] **Step 6: Record and commit**

```bash
git add \
  scripts/eval-search-ablation.ts test/search-ablation.test.ts \
  fixtures/qrels/subsystem-ablation.ndjson \
  docs/benchmarks/trust-stabilization-search-ablation.md \
  src/search/hybrid.ts src/search/eval.ts Makefile docs/SUBSYSTEMS.md DECISIONS.md
git commit -m "eval: resolve pending search multiplier evidence"
```

Rollback restores the prior constants and scorecard-linked decision; no data/schema change.

---

### Task 3: Split the SQL repository by domain behind a stable facade

**Files:**

- Create: `src/db/repos/access.ts`
- Create: `src/db/repos/audit.ts`
- Create: `src/db/repos/inbox.ts`
- Create: `src/db/repos/metrics.ts`
- Create: `src/db/repos/runtime.ts`
- Create: `test/db-boundaries.test.ts`
- Modify: `src/db/repo.ts`
- Modify: `src/cli.ts`
- Modify: `scripts/with-ops-lease.ts`
- Modify: `test/ops-locking.test.ts`
- Modify: `CLAUDE.md`
- Modify: `docs/SYSTEM-CONTRACT.md`
- Modify: `docs/SUBSYSTEMS.md`
- Modify: `DECISIONS.md`

**Responsibility map:**

```text
access.ts   repository allowed-tier and unlock primitives
audit.ts    event insert/query and content-free payload door
inbox.ts    inbox state, archive metadata, filing claims, review queue
metrics.ts  definitions, aggregate execution, stored rollups, anomalies
runtime.ts  daemon/job advisory leases and schema posture
repo.ts     stable re-export facade plus remaining domain SQL
```

All existing public names remain re-exported from `src/db/repo.ts`, so application import
sites need not change in this task. `db()`, `hasDbTransaction()`, `reserveDb()`,
`reserveLocalDb()`, `withDbTransaction()`, and `withReservedDb()` remain in
`src/db/client.ts`;
repository-owned `withActorDbSession()` and its `set_config` SQL remain in
`src/db/repo.ts`. This task does not move or wrap the S1 scoped-client primitive.

**Exact move manifests:**

```text
runtime.ts
  RuntimeLeaseName
  RuntimeLease
  tryAcquireRuntimeLease
  withRuntimeLease
  AdminOpsLeaseName
  AdminOpsLeaseCapability
  InheritedAdminOpsLease
  withAdminOpsLease
  runUnderAdminOpsLease
  RuntimeRolePosture
  runtimeRolePosture
  assertRuntimeRolePosture

metrics.ts
  MetricDefinition
  metricAnomalies
  metricDef
  listMetricDefs
  runMetricAgg
  storedMetricValues
  upsertMetricValue

inbox.ts
  InboxItem
  InboxDerivativeKind
  insertInboxItem
  getInboxItem
  findInboxByPath
  findInboxByIdentity
  pendingInboxItems
  setInboxArchiveIdentity
  claimInboxForFiling
  finishInboxFiling
  resetInboxFiling
  findInboxDerivative
  requeueInboxFilingsForRollback
  setInboxFiled
  setInboxPending
  setInboxRejected
  insertReviewItem
  openReviewItems
  resolveReviewItem
  resolveInboxReviewItems
  reviewItemExists

audit.ts
  logEvent
  eventsSince
  accessCounts

access.ts
  AccessActor
  allowedTier
  insertUnlock
```

These names are the cross-plan contract after S1, S2, and S4. If implementation discovers
that a listed private helper is needed by its moved public functions, move that helper
without exporting it. Do not add another public symbol or change a signature during this
behavior-preserving split.

Updated SQL boundary:

```text
Application domain SQL may exist only in src/db/repo.ts and src/db/repos/*.ts.
Connection construction, transaction scope, and connection reservation remain in
src/db/client.ts; client.ts contains no tagged SQL and may not query an application table.
Migration-ledger bootstrap SQL may remain in src/db/migrate.ts.
Schema/metric SQL remains in numbered migrations and metric_defs.agg_sql.
```

Fixed ceilings after the split:

```text
src/db/repo.ts                      <= 2400 lines
each src/db/repos/*.ts              <= 650 lines
src/pipeline/notes.ts               <= 1950 lines
any new production TypeScript file <= 800 lines
```

- [ ] **Step 1: Capture the pre-move behavior baseline**

Before creating `src/db/repos/`, run the focused behavior suites that will be repeated after
each move:

```bash
bun test \
  test/runtime-lease.test.ts \
  test/metric-rollup.test.ts \
  test/inbox-rollback.test.ts \
  test/inbox-review-workflow.test.ts \
  test/h4-audit-state.test.ts \
  test/h4-audit-transport.test.ts \
  test/access-boost.test.ts \
  test/db-actor-session.test.ts \
  test/privacy-hardening.test.ts \
  test/m15.roles.test.ts
```

Expected: PASS on the unsplit facade. Stop if any behavior suite is already red; this task
must not combine a bug fix with the move.

- [ ] **Step 2: Write the shared SQL-boundary and fixed-ceiling RED tests**

In `test/db-boundaries.test.ts`, recursively scan `src/**/*.ts` and reject a Postgres
tagged-template import/use outside:

```text
src/db/repo.ts
src/db/repos/*.ts
src/db/client.ts
src/db/migrate.ts
```

The `src/db/client.ts` exception permits only connection construction, transaction scope,
and reservation/release; fail on any tagged SQL, application-table name, or domain CRUD.
Assert the fixed ceilings above, reject a domain module over 650 lines, and assert no
application module imports `src/db/repos/*` directly.
`src/db/repo.ts` is the application facade; only `test/db-boundaries.test.ts` may import a
domain module to compare identity.

- [ ] **Step 3: Prove the fixed-ceiling test is RED**

```bash
bun test test/db-boundaries.test.ts -t "fixed ceilings"
```

Expected: fail because the current `src/db/repo.ts` exceeds 2400 lines. This RED remains
until enough domains have moved; use the per-domain facade tests below for intermediate
GREEN commits.

- [ ] **Step 4: Write the runtime facade RED test**

Add a test that imports `src/db/repos/runtime.ts` and compares each runtime value export with
the facade:

```ts
expect(repo.tryAcquireRuntimeLease).toBe(runtime.tryAcquireRuntimeLease);
expect(repo.withRuntimeLease).toBe(runtime.withRuntimeLease);
expect(repo.withAdminOpsLease).toBe(runtime.withAdminOpsLease);
expect(repo.runUnderAdminOpsLease).toBe(runtime.runUnderAdminOpsLease);
expect(repo.runtimeRolePosture).toBe(runtime.runtimeRolePosture);
expect(repo.assertRuntimeRolePosture).toBe(runtime.assertRuntimeRolePosture);
```

Use TypeScript assignments to prove the facade also exports the identical
`RuntimeLeaseName`, `RuntimeLease`, `AdminOpsLeaseName`, `AdminOpsLeaseCapability`,
`InheritedAdminOpsLease`, and `RuntimeRolePosture` types.

- [ ] **Step 5: Prove the runtime facade test is RED**

```bash
bun test test/db-boundaries.test.ts -t "runtime facade"
```

Expected: fail because `src/db/repos/runtime.ts` does not exist.

- [ ] **Step 6: Move runtime SQL and preserve the facade**

Move the exact runtime manifest and its private advisory-key helpers verbatim from
`src/db/repo.ts` into `src/db/repos/runtime.ts`. Runtime/job leases continue to consume
S1's singleton `reserveDb()`; topology continues to consume S3's
`reserveLocalDb({ databaseUrl, database: "postgres" })`. Import both client seams from
`../client`; never construct a pool or silently substitute the runtime reservation for the
admin one inside the repository module.
In `src/db/repo.ts`, add explicit value/type re-exports:

```ts
export {
  assertRuntimeRolePosture,
  runtimeRolePosture,
  tryAcquireRuntimeLease,
  withAdminOpsLease,
  runUnderAdminOpsLease,
  withRuntimeLease,
} from "./repos/runtime";
export type {
  AdminOpsLeaseCapability,
  AdminOpsLeaseName,
  InheritedAdminOpsLease,
  RuntimeLease,
  RuntimeLeaseName,
  RuntimeRolePosture,
} from "./repos/runtime";
```

If remaining code in `repo.ts` calls one of these functions, also import that same domain
export locally; do not leave a duplicate implementation. Change `src/cli.ts`,
`scripts/with-ops-lease.ts`, and `test/ops-locking.test.ts` to import
`runUnderAdminOpsLease`/`withAdminOpsLease` from the stable `src/db/repo.ts` facade, never
the domain module. Run
`rg -n 'runUnderAdminOpsLease|withAdminOpsLease|reserveLocalDb' src scripts test` and
require that application/ops callers import topology functions only from the facade,
`reserveLocalDb` is used only by the runtime repository, and no caller imports the runtime
domain directly.

- [ ] **Step 7: Verify and commit the runtime move**

```bash
bun test test/db-boundaries.test.ts -t "runtime facade"
bun test \
  test/runtime-lease.test.ts \
  test/ops-locking.test.ts \
  test/m15.roles.test.ts
git add \
  src/db/repos/runtime.ts src/db/repo.ts src/cli.ts \
  scripts/with-ops-lease.ts test/ops-locking.test.ts \
  test/db-boundaries.test.ts
git commit -m "refactor: move runtime repository domain"
```

Expected: facade identity and runtime/role behavior pass. Application imports remain
unchanged.

- [ ] **Step 8: Write the metrics facade RED test**

Compare `metricAnomalies`, `metricDef`, `listMetricDefs`, `runMetricAgg`,
`storedMetricValues`, and `upsertMetricValue` by reference between
`src/db/repos/metrics.ts` and `src/db/repo.ts`. Add a TypeScript assignment for
`MetricDefinition`.

- [ ] **Step 9: Prove the metrics facade test is RED**

```bash
bun test test/db-boundaries.test.ts -t "metrics facade"
```

Expected: fail because `src/db/repos/metrics.ts` does not exist.

- [ ] **Step 10: Move metrics SQL and preserve internal callers**

Move the exact metrics manifest plus private date/row decoders into
`src/db/repos/metrics.ts` without changing SQL. Add explicit facade re-exports. Because
`stateSnapshot()` remains in `repo.ts` and calls `metricAnomalies()`, import that function
from `./repos/metrics` for local use as well as re-exporting it.

```ts
import { metricAnomalies } from "./repos/metrics";
export {
  listMetricDefs,
  metricAnomalies,
  metricDef,
  runMetricAgg,
  storedMetricValues,
  upsertMetricValue,
} from "./repos/metrics";
export type { MetricDefinition } from "./repos/metrics";
```

Do not move `src/pipeline/metric-rollup.ts`; it remains pipeline-owned and contains no SQL.

- [ ] **Step 11: Verify and commit the metrics move**

```bash
bun test test/db-boundaries.test.ts -t "metrics facade"
bun test test/metric-rollup.test.ts test/m2.tools.test.ts test/m6.leak.test.ts
git add src/db/repos/metrics.ts src/db/repo.ts test/db-boundaries.test.ts
git commit -m "refactor: move metrics repository domain"
```

- [ ] **Step 12: Write the inbox facade RED test**

Compare every value name in the inbox manifest by reference. Add a TypeScript assignment for
`InboxItem` and `InboxDerivativeKind`. Assert source text under `src/pipeline/` and
`src/mcp/` still imports inbox repository functions only from `../db/repo` or
`../../db/repo`, never from the domain module.

- [ ] **Step 13: Prove the inbox facade test is RED**

```bash
bun test test/db-boundaries.test.ts -t "inbox facade"
```

Expected: fail because `src/db/repos/inbox.ts` does not exist.

- [ ] **Step 14: Move inbox/review SQL and preserve the facade**

Move the exact inbox manifest and private row decoders into `src/db/repos/inbox.ts`. Keep the
migration-023 tier-2 predicates and migration-024 claim conditions byte-for-byte equivalent.
Add explicit facade re-exports. If `repo.ts`'s dream/state helpers call `reviewItemExists()`
or another moved symbol, import it locally from `./repos/inbox`; delete the old definition.

```ts
export {
  claimInboxForFiling,
  findInboxByIdentity,
  findInboxByPath,
  findInboxDerivative,
  finishInboxFiling,
  getInboxItem,
  insertInboxItem,
  insertReviewItem,
  openReviewItems,
  pendingInboxItems,
  requeueInboxFilingsForRollback,
  resetInboxFiling,
  resolveInboxReviewItems,
  resolveReviewItem,
  reviewItemExists,
  setInboxArchiveIdentity,
  setInboxFiled,
  setInboxPending,
  setInboxRejected,
} from "./repos/inbox";
export type { InboxDerivativeKind, InboxItem } from "./repos/inbox";
```

Do not move `src/pipeline/inbox-filing.ts` or `src/pipeline/inbox-paths.ts`; only their SQL
repository functions move.

- [ ] **Step 15: Verify and commit the inbox move**

```bash
bun test test/db-boundaries.test.ts -t "inbox facade"
bun test \
  test/inbox-tier-policy.test.ts \
  test/inbox-filing-service.test.ts \
  test/inbox-rollback.test.ts \
  test/inbox-review-workflow.test.ts \
  test/privacy-hardening.test.ts
git add src/db/repos/inbox.ts src/db/repo.ts test/db-boundaries.test.ts
git commit -m "refactor: move inbox repository domain"
```

- [ ] **Step 16: Write the audit facade RED test**

Compare `logEvent`, `eventsSince`, and `accessCounts` by reference. Assert
`src/util/event-payload.ts` remains the owner of `EventPayload` and
`assertContentFreeEventPayload()`; no new `src/audit/` path is introduced and the database
domain does not import upward from `src/mcp/`.

- [ ] **Step 17: Prove the audit facade test is RED**

```bash
bun test test/db-boundaries.test.ts -t "audit facade"
```

Expected: fail because `src/db/repos/audit.ts` does not exist.

- [ ] **Step 18: Move audit SQL and preserve validation**

Move the exact audit manifest and private event-row decoder into `src/db/repos/audit.ts`.
Keep the call to `assertContentFreeEventPayload()` immediately before event insertion.
Import that validator from `../../util/event-payload`, add explicit facade re-exports, and
do not move or duplicate the payload schema registry.

```ts
export { accessCounts, eventsSince, logEvent } from "./repos/audit";
```

- [ ] **Step 19: Verify and commit the audit move**

```bash
bun test test/db-boundaries.test.ts -t "audit facade"
bun test \
  test/h4-audit-state.test.ts \
  test/h4-audit-transport.test.ts \
  test/access-boost.test.ts \
  test/privacy-hardening.test.ts
git add src/db/repos/audit.ts src/db/repo.ts test/db-boundaries.test.ts
git commit -m "refactor: move audit repository domain"
```

- [ ] **Step 20: Write the access facade RED test**

Compare `allowedTier` and `insertUnlock` by reference and add a TypeScript assignment for
`AccessActor`. Assert `src/db/client.ts` still owns `db()`, `hasDbTransaction()`,
`reserveDb()`, `reserveLocalDb()`, `withDbTransaction()`, and `withReservedDb()`, while
`src/db/repo.ts`
retains `withActorDbSession()`.

- [ ] **Step 21: Prove the access facade test is RED**

```bash
bun test test/db-boundaries.test.ts -t "access facade"
```

Expected: fail because `src/db/repos/access.ts` does not exist.

- [ ] **Step 22: Move access SQL and preserve repo-local use**

Move `AccessActor`, `allowedTier`, `insertUnlock`, and their private unlock lookup helpers
into `src/db/repos/access.ts`. Add explicit facade re-exports. Import `allowedTier` and
`AccessActor` back into `repo.ts` because remaining search/state/graph functions use them.
Do not change actor session scope, capability validation, SQL predicates, or error codes.

```ts
import { allowedTier } from "./repos/access";
import type { AccessActor } from "./repos/access";
export { allowedTier, insertUnlock } from "./repos/access";
export type { AccessActor } from "./repos/access";
```

- [ ] **Step 23: Verify and commit the access move**

```bash
bun test test/db-boundaries.test.ts -t "access facade"
bun test \
  test/db-actor-session.test.ts \
  test/privacy-hardening.test.ts \
  test/m15.roles.test.ts
git add src/db/repos/access.ts src/db/repo.ts test/db-boundaries.test.ts
git commit -m "refactor: move access repository domain"
```

- [ ] **Step 24: Run the complete boundary/equivalence gate**

Now run the previously RED fixed-ceiling test and every moved-domain suite together:

```bash
bun test \
  test/db-boundaries.test.ts \
  test/runtime-lease.test.ts \
  test/metric-rollup.test.ts \
  test/inbox-rollback.test.ts \
  test/inbox-review-workflow.test.ts \
  test/h4-audit-state.test.ts \
  test/h4-audit-transport.test.ts \
  test/access-boost.test.ts \
  test/db-actor-session.test.ts \
  test/privacy-hardening.test.ts \
  test/m15.roles.test.ts
make verify
```

Expected: all facade identities, direct-import prohibition, SQL boundary, fixed ceilings,
and behavior suites pass.

- [ ] **Step 25: Record the SQL-boundary amendment**

Update `CLAUDE.md` and `docs/SYSTEM-CONTRACT.md` with:

```text
Application domain SQL may exist only in src/db/repo.ts and src/db/repos/*.ts.
All application callers import the stable src/db/repo.ts facade.
Connection/transaction/reservation plumbing remains in src/db/client.ts and contains no SQL.
Actor `set_config` SQL remains behind the src/db/repo.ts facade.
Migration-ledger bootstrap SQL may remain in src/db/migrate.ts.
```

Update `docs/SUBSYSTEMS.md` without creating five new subsystem rows:

```text
Runtime daemon       add src/db/repos/runtime.ts
Dream job            add src/db/repos/metrics.ts
Watcher + classifier add src/db/repos/inbox.ts
MCP door             add src/db/repos/audit.ts
Tier/RLS enforcement add src/db/repos/access.ts
```

Append the owner-approved behavior-preserving boundary amendment to `DECISIONS.md`.

- [ ] **Step 26: Commit the contract/inventory update**

```bash
git add \
  CLAUDE.md docs/SYSTEM-CONTRACT.md docs/SUBSYSTEMS.md DECISIONS.md
git commit -m "docs: record repository domain boundary"
```

Rollback is code-only; the facade preserves callers and there is no migration.

---

### Task 4: Enforce complexity, architecture, and final release evidence

**Files:**

- Create: `scripts/check-complexity.ts`
- Create: `config/complexity-budget.json`
- Create: `test/architecture-boundaries.test.ts`
- Create: `test/complexity-budget.test.ts`
- Create: `docs/releases/trust-stabilization.md`
- Modify: `scripts/check-subsystems.ts`
- Modify: `docs/SUBSYSTEMS.md`
- Modify: `tsconfig.json`
- Modify: `package.json`
- Modify: `Makefile`
- Modify: `.github/workflows/eval.yml`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Committed complexity budget:**

```json
{
  "maxProductionTsLines": 800,
  "pathCeilings": {
    "src/db/repo.ts": 2400,
    "src/pipeline/notes.ts": 1950
  },
  "maxRuntimeDependencies": 7,
  "pendingEvalRequiresReviewDate": true
}
```

Existing larger generated/test fixtures are explicitly outside the production-file limit.
Any future ceiling increase requires an owner-approved decision and a replacement/deletion
statement.

Architecture tests assert:

- MCP modules do not import scheduler/watcher/dream/backup modules.
- Only `src/runtime/daemon.ts` owns Croner/background handles.
- Only the dedicated backup worker loads the backup profile or runs the raw dump path;
  manual, daemon, Dream, and update callers delegate through the same public leased parent.
- The topology lease is exported by the repository facade from `src/db/repos/runtime.ts`,
  uses the admin-profile `postgres` reservation seam, and never falls back to the singleton
  runtime pool.
- Watcher and review tool use `inbox-filing.ts`.
- Metric tool and dream use `src/pipeline/metric-rollup.ts`, which remains owned by the
  existing Dream job/metric plumbing inventory row rather than a new top-level subsystem.
- All event inserts pass through the audited payload door.
- Application SQL stays in the declared DB boundary.
- Every subsystem row has nonempty evidence/deletion/dependency/maintenance cells.
- A row containing `pending` includes a fixed review date; an expired date fails.

TypeScript coverage expands to `scripts/` in this task; operational scripts are fixed until
`bun run typecheck` passes without relaxing strictness.

- [ ] **Step 1: Write architecture and budget RED tests**

Plant no exceptions in test code. The current repository must fail at least the stronger
subsystem/pending-date and script-typecheck assertions before implementation.

- [ ] **Step 2: Implement deterministic filesystem checks**

`check-complexity.ts` reads only committed config and source files, performs no Git/network
call, and emits fixed path/count failures.

- [ ] **Step 3: Strengthen subsystem validation**

Update pending rows with an owner-approved review date or the S5 ablation result. Do not mark
unproven evidence as proven.

- [ ] **Step 4: Align Make and CI**

Final targets:

```make
check-architecture:
	@$(BUN) test test/architecture-boundaries.test.ts test/db-boundaries.test.ts

check-complexity:
	@$(BUN) run scripts/check-complexity.ts

verify-offline: verify-m0-offline test lint typecheck check-subsystems check-architecture check-complexity
verify: verify-offline eval-search
```

- [ ] **Step 5: Produce final content-free release evidence**

`docs/releases/trust-stabilization.md` records:

- merged branch SHAs;
- automated command statuses;
- privacy/runtime/recovery/core acceptance statuses;
- migration numbers 021-025;
- restore E2E run ID/status;
- search ablation result;
- rollback commands and compatibility-removal date;
- remaining known issues.

- [ ] **Step 6: Run final train gate**

```bash
bun install --frozen-lockfile
make verify
bash -n scripts/*.sh
git diff --check
```

- [ ] **Step 7: Commit**

```bash
git add \
  scripts/check-complexity.ts config/complexity-budget.json \
  test/architecture-boundaries.test.ts test/complexity-budget.test.ts \
  docs/releases/trust-stabilization.md scripts/check-subsystems.ts \
  docs/SUBSYSTEMS.md tsconfig.json package.json Makefile \
  .github/workflows/eval.yml README.md AGENTS.md
git commit -m "ci: enforce system architecture and complexity budgets"
```

---

## S5 Acceptance and Rollback

Acceptance:

- One current normative contract matches code and commands.
- Pending search multipliers are either evidenced or neutralized.
- The SQL repository has focused domain modules and stable facade imports.
- Complexity, architecture, all tests, typecheck, lint, subsystem inventory, and retrieval
  regression are mandatory CI gates.
- Every future PR receives an explicit invariants/eval/rollback checklist.
- Final release evidence is committed and content-free.

Rollback:

- Contract/PR/check scripts are repository-only.
- Search multiplier defaults can revert using the committed ablation evidence.
- Repository module split is behavior-preserving and migration-free.
- Do not remove the authoritative full test gate or restore the obsolete sole-source claim.
