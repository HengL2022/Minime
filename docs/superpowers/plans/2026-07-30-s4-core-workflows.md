# S4 Core Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the onboarding, capture/archive, review/refile, and metric workflows that
Minime's owner-facing guide already promises.

**Architecture:** Migration 023 makes raw inbox rows permanently tier 2 and gives each capture
an immutable archive identity. Automatic filing and actor-unlocked review then converge on one
recoverable service. Values, goals, and principles receive stable indexing and state exposure.
Metric definitions declare their rollup, and one pure helper under the existing pipeline
surface is shared by the MCP metric tool and dream job.

**Tech Stack:** Bun/TypeScript, PostgreSQL migrations 023-025, MCP tools, existing
`src/pipeline/`, `src/search/`, and atomic-file utilities, Markdown archives, and SQL-backed
metrics.

## Global Constraints

- The migration reservation is fixed: `023_inbox_archive_identity.sql`,
  `024_inbox_refile_state.sql`, and `025_metric_rollups.sql`. Do not reuse or reorder these
  numbers.
- Raw `inbox_items` rows are tier 2 from receipt through filed/rejected state. Filing may
  create a tier-1 derivative only when that target's existing policy permits it; the raw row
  is never downgraded.
- Migration 023 must backfill existing inbox rows, set the column default, and normalize an
  explicit tier-1 write from an old binary to tier 2. Rejecting the old write is not rollback
  compatible.
- Tier-2 `inbox_unfiled` review rows are omitted from a locked queue listing under S1 migration
  022. Content masking remains defense in depth for other visible review kinds.
- Filesystem and database changes are not represented as one transaction. Deterministic
  identity plus recoverable states provide idempotency.
- Existing source/archive files are never renamed, overwritten, or deleted by migration.
- Automatic classification and review refiling call the same filing service.
- Search works through FTS when embeddings are unavailable.
- Metric arithmetic remains in the SQL metric door plus `src/pipeline/metric-rollup.ts`; no
  model arithmetic and no new top-level metrics directory/subsystem are introduced.
- Historical daily metric values and source rows are never deleted.
- Add no runtime dependency. New files belong to the existing Watcher + classifier, Search
  indexing, Dream job, or plumbing inventory rows in `docs/SUBSYSTEMS.md`.

## File Responsibility Map

| File | Single responsibility |
|---|---|
| `db/migrations/023_inbox_archive_identity.sql` | tier-2 raw-inbox invariant and immutable archive metadata |
| `src/pipeline/inbox-paths.ts` | collision-safe relative paths and archive publication |
| `db/migrations/024_inbox_refile_state.sql` | recoverable `pending → filing → filed/rejected` state |
| `src/pipeline/inbox-filing.ts` | the only typed filing implementation used by watcher and MCP |
| `src/search/index-structured.ts` | render/index value, goal, and principle parents |
| `db/migrations/025_metric_rollups.sql` | declared metric rollup and streak-history correction |
| `src/pipeline/metric-rollup.ts` | deterministic pure day/week/month aggregation |

---

### Task 1: Enforce tier-2 raw inbox storage and add archive identity columns

This task is a database/privacy gate. It does not change filesystem naming or filing behavior.

**Files:**

- Create: `db/migrations/023_inbox_archive_identity.sql`
- Create: `test/inbox-tier-policy.test.ts`
- Modify: `src/db/repo.ts`
- Modify: `test/helpers.ts`
- Modify: `test/m1.schema.test.ts`
- Modify: `DECISIONS.md`

**Interfaces:**

- Consumes: S1 migration 022's actor-scoped tier/RLS and tier-2 `inbox_unfiled` queue policy.
- Produces: nullable `archive_path` and `raw_sha256`, plus the invariant
  `inbox_items.tier = 2`.
- Preserves:

```ts
export async function insertInboxItem(
  input: {
    rawPath: string;
    mime?: string | null;
    rawSha256?: string | null;
    createdBy?: string;
    source?: string;
  },
): Promise<{ id: string }>;
```

`insertInboxItem()` must explicitly write `2`, even though the database also enforces it.

- [ ] **Step 1: Add a migration-range test helper**

Add this test-only interface to `test/helpers.ts`:

```ts
export async function resetDbThrough(lastMigration: string): Promise<void>;
```

It performs the same table/function cleanup as `resetDb()`, creates `schema_migrations`, reads
the sorted numbered SQL files, and applies and records files only through the exact inclusive
filename. Refuse a filename not present in the directory. This is used only by the focused
upgrade test; production migration code is unchanged.

- [ ] **Step 2: Write the failing upgrade/backfill test**

In `test/inbox-tier-policy.test.ts`, use `resetDbThrough("022_engineer_content_rls.sql")`,
insert one legacy row with `tier = 1`, then call `migrate({ kind: "test" })` under the S0
migration-context contract. Assert:

```ts
expect(applied).toContain("023_inbox_archive_identity.sql");
expect(Number(upgraded.tier)).toBe(2);
expect(upgraded.archive_path).toBeNull();
expect(upgraded.raw_sha256).toBeNull();
```

The test must restore the fully migrated schema in `afterAll(resetDb)` so a focused run leaves
the shared test database usable.

- [ ] **Step 3: Write the failing fresh-write and old-binary tests**

After a normal `resetDb()`:

```ts
const [defaulted] = await sql`
  insert into inbox_items (raw_path) values ('tier-default.md') returning tier`;
expect(Number(defaulted!.tier)).toBe(2);

const [legacyBinary] = await sql`
  insert into inbox_items (raw_path, tier)
  values ('legacy-explicit-one.md', 1)
  returning tier`;
expect(Number(legacyBinary!.tier)).toBe(2);

await sql`update inbox_items set tier = 1 where raw_path = 'legacy-explicit-one.md'`;
const [afterUpdate] = await sql`
  select tier from inbox_items where raw_path = 'legacy-explicit-one.md'`;
expect(Number(afterUpdate!.tier)).toBe(2);
```

Also call `insertInboxItem()` and assert its stored row is tier 2.

- [ ] **Step 4: Run the tier policy test and observe RED**

```bash
bun test test/inbox-tier-policy.test.ts
```

Expected: fail because migration 023, the archive columns, and tier normalizer do not exist;
the current repository write stores tier 1.

- [ ] **Step 5: Create migration 023 with the complete tier policy**

Create `db/migrations/023_inbox_archive_identity.sql` with these operations in this order:

```sql
alter table inbox_items add column archive_path text;
alter table inbox_items add column raw_sha256 text;

alter table inbox_items alter column tier set default 2;
update inbox_items set tier = 2 where tier is distinct from 2;

create or replace function enforce_inbox_item_tier2()
returns trigger language plpgsql as $$
begin
  new.tier := 2;
  return new;
end
$$;

drop trigger if exists inbox_items_force_tier2 on inbox_items;
create trigger inbox_items_force_tier2
before insert or update of tier on inbox_items
for each row execute function enforce_inbox_item_tier2();

alter table inbox_items
  add constraint inbox_items_raw_tier2 check (tier = 2) not valid;
alter table inbox_items validate constraint inbox_items_raw_tier2;

create unique index inbox_items_archive_path_unique
  on inbox_items (archive_path)
  where archive_path is not null;

create unique index inbox_items_raw_identity_unique
  on inbox_items (raw_path, raw_sha256)
  where raw_sha256 is not null;
```

The normalizing trigger is deliberate: an old binary currently sends an explicit `tier = 1`.
A check constraint alone would turn rollback into a capture outage.

- [ ] **Step 6: Change the current repository write to tier 2 and accept an optional hash**

In `src/db/repo.ts`, update `insertInboxItem()` to use the new identity column while keeping
the public return shape:

```ts
insert into inbox_items (raw_path, mime, raw_sha256, created_by, source, tier)
values (
  ${i.rawPath},
  ${i.mime ?? "text/plain"},
  ${i.rawSha256 ?? null},
  ${i.createdBy ?? "human"},
  ${i.source ?? "capture"},
  2
)
on conflict (raw_path, raw_sha256) where raw_sha256 is not null
do update set raw_path = excluded.raw_path
returning id
```

Do not add a caller-controlled tier argument. A null hash preserves old-binary insert
behavior; a non-null hash makes current capture replay return the existing ID.

- [ ] **Step 7: Teach resetDb about the trigger function and run GREEN**

Add `"enforce_inbox_item_tier2"` to the function cleanup list in `test/helpers.ts`, then run:

```bash
bun test test/inbox-tier-policy.test.ts test/m1.schema.test.ts
```

Expected: upgrade backfill, fresh default, explicit old-binary insert/update, repository write,
constraint inventory, and migration idempotency all pass.

- [ ] **Step 8: Record the privacy and rollback decision**

Append a dated `DECISIONS.md` entry stating:

```text
Raw inbox captures are tier 2 independent of eventual derivative tier. Migration 023
backfills existing rows, defaults new rows to 2, and normalizes explicit tier-1 writes so
one-release old binaries remain write-compatible. The raw row is never downgraded after
filing. Rollback keeps migration 023 applied.
```

- [ ] **Step 9: Commit the independently reviewable tier/schema gate**

```bash
git add \
  db/migrations/023_inbox_archive_identity.sql \
  test/inbox-tier-policy.test.ts test/helpers.ts test/m1.schema.test.ts \
  src/db/repo.ts DECISIONS.md
git commit -m "fix: enforce tier two raw inbox storage"
```

**Acceptance:** legacy rows are backfilled; default, current-binary, and explicit old-binary
writes all store tier 2; migration 023 is idempotent through the migration ledger.

**Rollback:** keep migration 023 and its trigger applied. Old code may still request tier 1,
but the database stores tier 2 without rejecting capture.

---

### Task 2: Publish collision-safe archive and note paths

**Files:**

- Create: `src/pipeline/inbox-paths.ts`
- Create: `test/inbox-paths.test.ts`
- Modify: `src/util/atomic-file.ts`
- Modify: `test/h1-note-archive.test.ts`
- Modify: `src/db/repo.ts`
- Modify: `src/pipeline/watcher.ts`
- Modify: `test/m10.classify-guardrails.test.ts`
- Modify: `test/m4.importers.test.ts`

**Interfaces:**

- Consumes: migration 023 columns and the tier-2 row identity from Task 1.
- Produces:

```ts
export function inboxArchiveRelativePath(input: {
  inboxItemId: string;
  receivedAt: Date;
  originalName: string;
}): string;

export function inboxNoteRelativePath(input: {
  inboxItemId: string;
  title: string;
}): string;

export interface InboxSourceSnapshot {
  originalName: string;
  bytes: Uint8Array;
  sha256: string;
}

export async function snapshotInboxSource(
  sourcePath: string,
): Promise<InboxSourceSnapshot>;

export async function archiveInboxSource(input: {
  source: InboxSourceSnapshot;
  inboxItemId: string;
  receivedAt: Date;
}): Promise<{ relativePath: string; sha256: string }>;

export async function atomicWritePrivateExclusive(
  target: string,
  bytes: Uint8Array | string,
): Promise<"created" | "exists">;

export async function setInboxArchiveIdentity(
  id: string,
  archivePath: string,
  rawSha256: string,
): Promise<void>;

export async function findInboxByIdentity(
  rawPath: string,
  rawSha256: string,
): Promise<{
  id: string;
  received_at: Date;
  status: "pending" | "filed" | "rejected";
  raw_sha256: string;
} | null>;
```

Paths are:

```text
archive/YYYY/MM/<safe-stem>--<full-inbox-uuid>.<ext>
inbox/<safe-slug>--<full-inbox-uuid>.md
```

The archive path is relative to `MINIME_DATA_DIR`; the note page path is relative to
`MINIME_DATA_DIR/brain`. UUID is identity; stem/slug is cosmetic.

- [ ] **Step 1: Write pure path RED tests**

Assert exact stable outputs for:

```ts
inboxArchiveRelativePath({
  inboxItemId: "123e4567-e89b-12d3-a456-426614174000",
  receivedAt: new Date("2026-07-30T12:00:00Z"),
  originalName: "../Quarterly / Notes.md",
});
// archive/2026/07/quarterly-notes--123e4567-e89b-12d3-a456-426614174000.md

inboxNoteRelativePath({
  inboxItemId: "123e4567-e89b-12d3-a456-426614174000",
  title: "Plan / Plan",
});
// inbox/plan-plan--123e4567-e89b-12d3-a456-426614174000.md
```

Also assert no output contains `..`, `\`, a control character, or an absolute prefix, and an
empty cosmetic stem becomes `capture`.

- [ ] **Step 2: Run the pure path test and observe RED**

```bash
bun test test/inbox-paths.test.ts -t "derives stable safe relative paths"
```

Expected: fail because `src/pipeline/inbox-paths.ts` does not exist.

- [ ] **Step 3: Implement only path normalization**

Create `src/pipeline/inbox-paths.ts`. Use `basename()` before splitting stem/extension,
lowercase ASCII, replace each non-alphanumeric run with one `-`, trim `-`, and cap the
cosmetic component at 80 characters. Validate the ID with the existing UUID shape before
interpolation. Preserve only a lowercase extension matching `/^\.[a-z0-9]{1,10}$/`; otherwise
use `.md`.

- [ ] **Step 4: Run the pure path test GREEN**

```bash
bun test test/inbox-paths.test.ts -t "derives stable safe relative paths"
```

- [ ] **Step 5: Write exclusive-publication RED tests**

In `test/h1-note-archive.test.ts`, test `atomicWritePrivateExclusive()` with injected
filesystem operations:

- first publication returns `"created"`;
- a second publication never replaces the target and returns `"exists"`;
- a symlink in any existing component throws `UNSAFE_PRIVATE_ROOT`;
- temp write, file sync, atomic no-replace publication, directory sync, and temp cleanup occur
  in that order;
- failure cleans only the owned temporary file.

Use hard-link publication (`link(temp, target)`) or an equivalent atomic no-replace primitive;
plain `rename(temp, target)` is invalid because POSIX rename can overwrite.

- [ ] **Step 6: Implement and verify exclusive atomic publication**

Extend `src/util/atomic-file.ts` with `atomicWritePrivateExclusive()` using the same
containment and mode checks as `atomicWritePrivate()`. Treat only `EEXIST` from the final
no-replace publication as `"exists"`; propagate every other error with content-free codes.

```bash
bun test test/h1-note-archive.test.ts -t "exclusive"
```

- [ ] **Step 7: Write archive replay/collision RED tests**

In `test/inbox-paths.test.ts`, create two byte-distinct source files named `note.md` and assert:

- different inbox IDs yield different archive paths and preserve both byte sequences;
- replacing one exact raw path with different bytes creates a second inbox ID/archive;
- replaying that raw path with identical bytes returns its existing inbox ID/archive;
- replay with the same inbox ID and same bytes returns the same path/hash;
- replay with the same inbox ID and different bytes throws `archive_collision`;
- a pre-created symlink target is rejected;
- stored paths remain relative to `config.dataDir`.

- [ ] **Step 8: Implement archiveInboxSource()**

`snapshotInboxSource()` reads the regular non-symlink source exactly once, retains those
bytes, and computes SHA-256. `archiveInboxSource()` must:

1. use only `source.bytes` and `source.sha256`, never re-read the mutable raw path;
2. derive the relative path from ID/date/`source.originalName`;
3. call `atomicWritePrivateExclusive(resolve(config.dataDir, relativePath), source.bytes)`;
4. on `"exists"`, read the existing regular non-symlink target and compare SHA-256;
5. return the path/hash on equality or throw `archive_collision` on mismatch.

Do not include a source or destination path in the thrown error.

- [ ] **Step 9: Add the archive metadata repository write**

Implement `setInboxArchiveIdentity()` as:

```sql
update inbox_items
set archive_path = $archivePath, raw_sha256 = $rawSha256
where id = $id
  and tier = 2
  and (archive_path is null or archive_path = $archivePath)
  and (raw_sha256 is null or raw_sha256 = $rawSha256)
```

Require exactly one updated row; otherwise throw fixed `archive_identity_conflict`.

Implement `findInboxByIdentity()` with a parameterized
`where raw_path = $rawPath and raw_sha256 = $rawSha256 and tier = 2 limit 1` query. It must
not fall back to path-only matching; the watcher performs the separately guarded legacy
fallback in Step 10.

- [ ] **Step 10: Transition processInboxFile() to ID-before-archive ordering**

In `src/pipeline/watcher.ts`:

1. delete `archiveCopy()`;
2. call `snapshotInboxSource(path)` once;
3. call `findInboxByIdentity(path, source.sha256)` first;
4. if there is no exact row, call `findInboxByPath(path)` only to reuse its latest legacy
   `pending` row when `raw_sha256` is null;
5. if neither exists, call
   `insertInboxItem({ rawPath: path, rawSha256: source.sha256, ... })`, whose unique conflict
   still closes a concurrent identical-capture race;
6. load that ID with `getInboxItem()`;
7. return before filesystem mutation only when status is `filed`/`rejected` **and**
   `raw_sha256 === source.sha256`;
8. call `archiveInboxSource()` using the snapshot and row ID/received timestamp;
9. call `setInboxArchiveIdentity()`;
10. classify text decoded from `source.bytes`, which are the same bytes archived.

Replace the note branch's slug-only path with:

```ts
const relPath = inboxNoteRelativePath({
  inboxItemId: inboxId,
  title: c.fields.title || firstLine,
});
```

Keep `derivedFrom: inboxId`; replay therefore upserts the same page and replaces the same
chunks.

- [ ] **Step 11: Run capture/replay GREEN tests**

```bash
bun test \
  test/inbox-paths.test.ts \
  test/h1-note-archive.test.ts \
  test/m10.classify-guardrails.test.ts \
  test/m4.importers.test.ts
```

Expected: same basename/title preserves separate data, replay is idempotent, and existing
classification behavior remains green.

- [ ] **Step 12: Commit the filesystem identity gate**

```bash
git add \
  src/pipeline/inbox-paths.ts test/inbox-paths.test.ts \
  src/util/atomic-file.ts test/h1-note-archive.test.ts \
  src/db/repo.ts src/pipeline/watcher.ts \
  test/m10.classify-guardrails.test.ts test/m4.importers.test.ts
git commit -m "fix: publish collision safe inbox archives"
```

**Acceptance:** no basename/title collision overwrites data, and retrying one inbox ID cannot
create a second archive or note page.

**Rollback:** migration 023 remains applied and new immutable filenames remain valid; old
archive filenames are not renamed.

---

### Task 3: Extract one recoverable filing service for automatic capture

This task changes automatic filing behind its existing watcher interface. It does not expose
raw content through MCP yet.

**Files:**

- Create: `db/migrations/024_inbox_refile_state.sql`
- Create: `src/pipeline/inbox-filing.ts`
- Create: `test/inbox-filing-service.test.ts`
- Create: `scripts/repairs/requeue-stale-inbox-filings.ts`
- Create: `test/inbox-rollback.test.ts`
- Modify: `src/db/repo.ts`
- Modify: `src/pipeline/watcher.ts`
- Modify: `test/m10.classify-guardrails.test.ts`
- Modify: `AGENTS.md`

**State machine:**

```text
pending → filing → filed
                 ↘ pending on recoverable failure
pending → rejected
```

Raw row tier remains 2 in every state.

**Interfaces:**

```ts
export type InboxFilingPrincipal =
  | { kind: "runtime"; actor: "agent:classifier" }
  | { kind: "actor"; actor: string };

export type InboxFilingTarget =
  | {
      type: "task";
      title: string;
      due?: string | null;
      completed?: boolean;
    }
  | { type: "journal"; mood?: number | null }
  | {
      type: "interaction";
      personName: string;
      kind: "meeting" | "call" | "message" | "email" | "note";
      subjectType?: "person" | "org" | null;
    }
  | {
      type: "decision_note";
      question: string;
      options?: string[];
      choice?: string | null;
    }
  | { type: "note"; title: string; tier?: 1 | 2 }
  | { type: "drop" };

export type InboxDerivativeKind =
  | "task"
  | "journal"
  | "interaction"
  | "decision_note"
  | "note";

export type InboxFilingOutcome =
  | { status: "filed"; filedTable: string; filedId: string }
  | { status: "needs_review"; reason: "duplicate" | "unfileable" }
  | { status: "rejected" };

export interface InboxItem {
  id: string;
  received_at: Date;
  raw_path: string;
  archive_path: string | null;
  raw_sha256: string | null;
  mime: string | null;
  status: "pending" | "filing" | "filed" | "rejected";
  filed_table: string | null;
  filed_id: string | null;
  classifier_output: unknown;
  filing_started_at: Date | null;
  tier: 2;
}

export async function fileInboxItem(input: {
  inboxItemId: string;
  principal: InboxFilingPrincipal;
  target: InboxFilingTarget;
  classifierOutput?: unknown;
  timeZone?: string;
}): Promise<InboxFilingOutcome>;

export function classificationToFilingTarget(
  classification: Classification,
  text: string,
): InboxFilingTarget | null;
```

Repository state transitions:

```ts
export async function claimInboxForFiling(
  id: string,
  staleBefore: Date,
): Promise<InboxItem | null>;

export async function finishInboxFiling(
  id: string,
  filedTable: string,
  filedId: string,
  classifierOutput?: unknown,
): Promise<void>;

export async function resetInboxFiling(
  id: string,
  classifierOutput?: unknown,
): Promise<void>;

export async function findInboxDerivative(
  inboxItemId: string,
  kind: InboxDerivativeKind,
): Promise<{ filedTable: string; filedId: string } | null>;

export async function findInboxByIdentity(
  rawPath: string,
  rawSha256: string,
): Promise<InboxItem | null>;

export async function requeueInboxFilingsForRollback(): Promise<{
  requeued: number;
  inboxItemIds: string[];
}>;
```

`classificationToFilingTarget()` maps only normalized classifier fields:

```text
task          title=fields.title||firstLine, due=valid fields.due|null,
              completed=completionSignal(text)
journal       mood=numeric fields.mood|null
interaction   personName=fields.person_name||"Unknown",
              kind=allowed fields.kind||"note",
              subjectType="person"|"org"|null
decision_note question=fields.question||firstLine,
              options=string-array fields.options||[],
              choice=string fields.choice|null
note          title=fields.title||firstLine,
              tier=2 for the agent-session hint and 1 otherwise
unknown       null
```

- [ ] **Step 1: Write state-transition RED tests**

In `test/inbox-filing-service.test.ts`, assert:

- only a tier-2 `pending` row can become `filing`;
- a second current claim returns null;
- a `filing` row older than `staleBefore` can be reclaimed;
- `finishInboxFiling()` requires `status = 'filing'`, stores IDs, clears
  `filing_started_at`, and retains tier 2;
- `resetInboxFiling()` returns a claimed row to pending and retains tier 2.

- [ ] **Step 2: Run the state test and observe RED**

```bash
bun test test/inbox-filing-service.test.ts -t "claim"
```

Expected: fail because migration 024 and transition functions do not exist.

- [ ] **Step 3: Add migration 024**

Create `db/migrations/024_inbox_refile_state.sql`:

```sql
alter table inbox_items drop constraint inbox_items_status_check;
alter table inbox_items
  add constraint inbox_items_status_check
  check (status in ('pending', 'filing', 'filed', 'rejected'));
alter table inbox_items add column filing_started_at timestamptz;
```

Do not change the tier default, normalizer, or constraint from migration 023.

- [ ] **Step 4: Implement and verify claim/reset/finish**

`claimInboxForFiling()` uses one `update ... returning`:

```sql
update inbox_items
set status = 'filing', filing_started_at = now()
where id = $id
  and tier = 2
  and (
    status = 'pending'
    or (status = 'filing' and filing_started_at < $staleBefore)
  )
returning *
```

`finishInboxFiling()` and `resetInboxFiling()` update only `tier = 2 and status = 'filing'`
and throw fixed `inbox_claim_lost` when no row changes.

```bash
bun test test/inbox-filing-service.test.ts -t "claim"
```

- [ ] **Step 5: Write RED tests for task and journal filing**

Use deterministic archived text from Task 2. Assert task filing performs dedup/date/completion
guardrails, creates or closes one task, indexes it, and finalizes the raw row. Assert journal
filing creates/indexes a tier-2 journal with `derived_from = inboxItemId`. Inject one index
failure after the derivative insert, assert the claim resets to pending, retry, and assert
the service reuses that derivative instead of inserting a second row **and** restores its
chunks before finalizing. For an action-plus-decision capture, fail after the primary task
insert and assert retry creates/reuses and indexes exactly one companion decision.

- [ ] **Step 6: Implement task and journal target branches**

Move the existing task and journal branches from watcher `fileRow()` into a private
`writeFilingTarget()` in `src/pipeline/inbox-filing.ts`. Preserve these call orders:

```text
task: normalize due → completed=target.completed??completionSignal(text)
      → openTasksForDedup → upsertTask(open/done) → indexParent
journal: insertJournal → indexParent(tier 2)
```

When a completed capture closes an existing open task, pass
`derivedFrom: inboxItemId`. Extend only `upsertTask()`'s ID-update branch with
`derived_from = coalesce($derivedFrom, derived_from)` so a crash retry finds that canonical
task instead of inserting a second done task.

The service claims first, reads the immutable archive, writes the derivative, calls
`finishInboxFiling()`, and catches failures to call `resetInboxFiling()` before rethrowing.
Before creating a derivative, call `findInboxDerivative(inboxItemId, target.type)`. Its
closed switch maps task→tasks, journal→journal_entries, interaction→interactions,
decision_note→decisions, and note→pages, then selects by
`derived_from = inboxItemId`. A found derivative skips insertion but does **not** skip the
rest of its target branch: reload the row, rerun `indexParent()` idempotently, heal any
target-specific secondary side effect, and only then call `finishInboxFiling()`. Every new
insert/upsert in this service passes `derivedFrom: inboxItemId`.

For a compound action-plus-decision task, recompute `splitActionDecision(text)`, call
`findInboxDerivative(inboxItemId, "decision_note")`, create the companion decision only when
missing, and reindex it before finalizing the primary task. Its event payload contains only
`task_id` and `decision_id`.

Before claiming, load the raw row. Return its stored `{ filedTable, filedId }` immediately
when status is already `filed`, and return `rejected` when already rejected. When another
non-stale `filing` claim owns the row, throw fixed `INBOX_BUSY`; do not wait or start a second
write. Before reading archive bytes, an actor principal must satisfy
`allowedTier(principal.actor) === 2`; otherwise throw fixed `TIER_LOCKED`. The runtime
principal is the trusted local daemon path established in S1.

```bash
bun test test/inbox-filing-service.test.ts -t "task|journal"
```

- [ ] **Step 7: Write RED tests for interaction and decision-note filing**

Assert the interaction branch resolves/creates exactly one person or organization, inserts
and indexes one interaction at tier 2, and the decision-note branch inserts/indexes one
decision at its existing tier policy.

- [ ] **Step 8: Implement interaction and decision-note branches**

Move the corresponding watcher branches with these exact transitions:

```text
interaction:
  resolve entity kind → ensurePerson/ensureOrg → insertInteraction → indexParent

decision_note:
  insertDecision → indexParent
```

Both inserts pass `derivedFrom: inboxItemId`, so `findInboxDerivative()` can finish a
post-insert crash replay. For a mixed completed-work decision, separately call
`findInboxDerivative(inboxItemId, "task")` before creating the companion done task; its
content-free event payload contains only `decision_id` and `task_id`. Finding the primary
decision must still run this companion-task check and reindex both recovered rows before
finalizing.

```bash
bun test test/inbox-filing-service.test.ts -t "interaction|decision"
```

- [ ] **Step 9: Write RED tests for note, drop, and duplicate outcomes**

Assert a note uses `inboxNoteRelativePath()`, `derivedFrom: inboxItemId`, `upsertPage()`, and
`indexParent()`. Missing note tier defaults to 2; an explicit permitted tier 1 creates only a
tier-1 derivative while the inbox row stays tier 2. Drop marks the row rejected. Duplicate
returns `needs_review` and produces exactly one duplicate review item.

- [ ] **Step 10: Implement note/drop/duplicate outcomes**

Use:

```text
note: deterministic page path → upsertPage → indexParent → finish claim
drop: setInboxRejected with fixed reviewed-drop reason
duplicate: check reviewItemExists → insertReviewItem(..., 2) once → reset claim to pending
```

Never copy raw text into an event payload or locked queue list.

```bash
bun test test/inbox-filing-service.test.ts -t "note|drop|duplicate"
```

- [ ] **Step 11: Switch the watcher call site and delete fileRow()**

In `processInboxFile()`:

```ts
const target = classificationToFilingTarget(c, text);
if (c.confidence >= CONFIDENCE_FLOOR && target) {
  const outcome = await fileInboxItem({
    inboxItemId: inboxId,
    principal: { kind: "runtime", actor: "agent:classifier" },
    target,
    classifierOutput: c,
  });
  return { inboxId, filed: outcome.status === "filed" };
}
```

Keep the low-confidence `inbox_unfiled` path, but preserve S1's explicit
`insertReviewItem("inbox_unfiled", payload, 2)` call. Delete the private `fileRow()` and all
imports used only by it from `watcher.ts`.

- [ ] **Step 12: Write the old-binary downgrade RED test**

In `test/inbox-rollback.test.ts`, create one pending, one filed, and two `filing` rows. Call
`requeueInboxFilingsForRollback()` and assert:

```ts
expect(result.requeued).toBe(2);
expect(new Set(result.inboxItemIds)).toEqual(new Set([filingA, filingB]));
expect(statuses).toEqual({
  [pendingId]: "pending",
  [filedId]: "filed",
  [filingA]: "pending",
  [filingB]: "pending",
});
expect(allRows.every((row) => Number(row.tier) === 2)).toBe(true);
expect(await requeueInboxFilingsForRollback()).toEqual({
  requeued: 0,
  inboxItemIds: [],
});
```

Assert the repair-module result contains only the count and inbox UUIDs, never raw paths,
classifier output, or derivative content. Add 137 `filing` rows and prove all 137 become
`pending`, while the repair audit summary contains the total
`counts:{requeued:137}` and only the first 100 UUIDs in deterministic sorted order. The
101st row must not make the mutation succeed and terminal auditing fail.

- [ ] **Step 13: Implement the sanctioned downgrade repair**

Add one repository update:

```sql
update inbox_items
set status = 'pending', filing_started_at = null
where status = 'filing' and tier = 2
returning id
```

Sort returned IDs before returning `{ requeued, inboxItemIds }`. Create
`scripts/repairs/requeue-stale-inbox-filings.ts` with this complete module shape:

```ts
const mod: RepairModule = {
  name: "requeue-stale-inbox-filings",
  description: "Reset in-progress inbox claims before an old-binary code rollback.",
  async run() {
    const result = await requeueInboxFilingsForRollback();
    return {
      counts: { requeued: result.requeued },
      ids: result.inboxItemIds.slice(0, 100),
    };
  },
};
export default mod;
```

The repository result retains every sorted UUID for direct verification, but the sanctioned
repair module deliberately caps only its audited `ids` field at S1's 100-ID envelope; the
uncapped `counts.requeued` remains the authoritative mutation total. Rollback verification
queries the database for zero remaining `filing` rows and never infers completeness from
the sampled audit IDs. It intentionally runs through `scripts/repair.ts`, so a private
pre-image is mandatory and the committed-script gate applies.

- [ ] **Step 14: Document and verify downgrade ordering**

Add this exact sequence to the S4 rollback section of `AGENTS.md`:

```bash
# stop the daemon and all MCP client processes, but leave PostgreSQL running
bun run src/cli.ts daemon:status  # must print: stopped
bun run scripts/repair.ts requeue-stale-inbox-filings
# only after the repair reports success: switch/restart the old binary
```

The repair must run from the committed new revision before checking out old code. Restarting
an old daemon while any row is `filing` is a failed rollback gate.

```bash
bun test test/inbox-rollback.test.ts test/m15.roles.test.ts
```

- [ ] **Step 15: Run automatic filing regression gates**

```bash
bun test \
  test/inbox-filing-service.test.ts \
  test/inbox-rollback.test.ts \
  test/inbox-paths.test.ts \
  test/m10.classify-guardrails.test.ts \
  test/m4.importers.test.ts
```

- [ ] **Step 16: Commit the service extraction and rollback repair**

```bash
git add \
  db/migrations/024_inbox_refile_state.sql \
  src/pipeline/inbox-filing.ts test/inbox-filing-service.test.ts \
  scripts/repairs/requeue-stale-inbox-filings.ts test/inbox-rollback.test.ts \
  src/db/repo.ts src/pipeline/watcher.ts \
  test/m10.classify-guardrails.test.ts AGENTS.md
git commit -m "refactor: centralize recoverable inbox filing"
```

**Acceptance:** automatic filing uses one claimed, recoverable service; watcher contains no
typed filing switch; every raw row remains tier 2.

**Rollback:** keep migrations 023-024. Stop writers and run the committed, pre-image-backed
`requeue-stale-inbox-filings` repair before switching binaries. The gate is zero remaining
`filing` rows; the old binary then sees pending work, while migration 023's tier normalizer
keeps its writes compatible.

---

### Task 4: Expose actor-unlocked inbox inspect/refile through the existing review tool

**Files:**

- Create: `test/inbox-review-workflow.test.ts`
- Modify: `src/pipeline/inbox-filing.ts`
- Modify: `src/db/repo.ts`
- Modify: `src/mcp/tools/review-queue.ts`
- Modify: `test/m2.tools.test.ts`
- Modify: `test/privacy-hardening.test.ts`
- Modify: `agents/skills/review-triage.md`
- Modify: `agents/skills/RESOLVER.md`

**Interfaces:**

- Consumes: `fileInboxItem()`, deterministic archive metadata, and S1 actor-scoped unlock.
- Produces:

```ts
export async function inspectInboxItem(input: {
  inboxItemId: string;
  actor: string;
}): Promise<{
  id: string;
  text: string;
  classifierOutput: unknown;
}>;

export async function resolveInboxReviewItems(
  inboxItemId: string,
): Promise<number>;
```

Tool parameters:

```ts
action: z.enum(["list", "inspect", "refile", "resolve"]).default("list"),
kind: z.enum(KINDS).optional(),
id: z.string().uuid().optional(), // review item, resolve only
status: z.enum(["resolved", "dismissed"]).optional(),
inbox_item_id: z.string().uuid().optional(), // inspect/refile
filing: z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task"),
    title: z.string().min(1),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    completed: z.boolean().optional(),
  }),
  z.object({ type: z.literal("journal"), mood: z.number().int().min(1).max(5).nullable().optional() }),
  z.object({
    type: z.literal("interaction"),
    personName: z.string().min(1),
    kind: z.enum(["meeting", "call", "message", "email", "note"]),
    subjectType: z.enum(["person", "org"]).nullable().optional(),
  }),
  z.object({
    type: z.literal("decision_note"),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).optional(),
    choice: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("note"),
    title: z.string().min(1),
    tier: z.union([z.literal(1), z.literal(2)]).optional(),
  }),
  z.object({ type: z.literal("drop") }),
]).optional(),
```

- [ ] **Step 1: Write locked-list and locked-inspect RED tests**

Insert a tier-2 inbox row plus tier-2 `inbox_unfiled` review item. Without unlock:

```ts
expect(listedIds).not.toContain(reviewItemId);
await expect(inspect()).rejects.toMatchObject({ code: "TIER_LOCKED" });
expect(JSON.stringify(response)).not.toContain(rawSentinel);
```

Unlock actor A. Actor A can inspect; actor B still cannot. Expiry restores the refusal.

- [ ] **Step 2: Write legacy-path refusal RED tests**

For a migration-023 row, inspection reads only
`resolve(config.dataDir, row.archive_path)`. For a legacy null `archive_path`, allow
`raw_path` only after `lstat` and `realpath` prove it is a regular non-symlink file beneath
the configured inbox or archive root. Assert traversal, arbitrary absolute path, symlink,
missing file, and out-of-root paths fail with `inbox_archive_unavailable` and no path echo.

- [ ] **Step 3: Run access tests and observe RED**

```bash
bun test test/inbox-review-workflow.test.ts -t "inspect|locked|legacy"
```

- [ ] **Step 4: Implement inspectInboxItem() with a tier-2 gate**

Load the row by ID, require `row.tier === 2`, then call `allowedTier(actor)`. If it is below 2,
throw an error that the MCP handler maps to:

```ts
new ToolError("TIER_LOCKED", "unlock tier 2 before inspecting inbox content")
```

Return raw text only after the immutable/legacy path validation succeeds. Do not add
`inbox_item` to the general `minime_get_context` parent-type surface.

- [ ] **Step 5: Run inspect tests GREEN**

```bash
bun test test/inbox-review-workflow.test.ts -t "inspect|locked|legacy"
```

- [ ] **Step 6: Write refiling/idempotency RED tests**

Through the MCP tool, assert:

- note refiling creates one page/chunk set, finalizes the inbox IDs, and resolves all linked
  `inbox_unfiled` review rows;
- task refiling honors explicit `completed`; when omitted it deterministically applies
  `completionSignal()` to archived text;
- journal, interaction, decision-note, note, and drop return their exact service outcome;
- replay returns the existing filed/rejected outcome without duplicate rows/files/chunks;
- two concurrent actor requests produce one successful claim and one fixed `INBOX_BUSY`;
  replay after the winner finishes returns the stored idempotent outcome;
- a stale claim recovers;
- raw inbox tier remains 2 for every derivative tier.

- [ ] **Step 7: Implement linked-review resolution**

Add `resolveInboxReviewItems()` as one content-free update:

```sql
update review_queue
set status = 'resolved', resolved_at = now()
where kind = 'inbox_unfiled'
  and status = 'open'
  and payload->>'inbox_item_id' = $inboxItemId
returning id
```

Return only the count. Call it after `fileInboxItem()` reaches `filed` or `rejected`, never
before. Also call it when `fileInboxItem()` returns an already-stored filed/rejected replay
outcome, so a prior post-filing queue-resolution failure heals on retry.

- [ ] **Step 8: Add inspect/refile branches to reviewQueueTool**

Exact validation:

```text
inspect requires inbox_item_id
refile requires inbox_item_id and filing
resolve requires review-item id and status
list accepts optional kind only
```

`refile` passes:

```ts
{
  inboxItemId: params.inbox_item_id,
  principal: { kind: "actor", actor: ctx.actor },
  target: params.filing,
  timeZone: ctx.timeZone,
}
```

Return `inbox_item` and derivative source refs only after the actor-unlocked operation
succeeds. The list branch must call S1's actor-filtered
`openReviewItems(params.kind, ctx.actor)`; do not restore the pre-S1 unscoped call.

- [ ] **Step 9: Preserve queue-only resolution honesty**

Keep `resolve` separate from `refile`. Its payload is exactly:

```json
{"queue_status":"resolved","content_filed":false}
```

It must not mutate `inbox_items`.

- [ ] **Step 10: Run MCP/privacy GREEN gates**

```bash
bun test \
  test/inbox-review-workflow.test.ts \
  test/m2.tools.test.ts \
  test/privacy-hardening.test.ts \
  test/m10.classify-guardrails.test.ts
make verify-m2
make verify-m6
```

- [ ] **Step 11: Update the routed skill after behavior is green**

`agents/skills/review-triage.md` must tell the agent:

1. list `inbox_unfiled`;
2. unlock tier 2;
3. inspect by `inbox_item_id`;
4. ask task/journal/interaction/decision-note/note/drop;
5. call `refile`;
6. report the returned derivative source.

`agents/skills/RESOLVER.md` continues to route review requests to that file.

- [ ] **Step 12: Commit the MCP review gate**

```bash
git add \
  test/inbox-review-workflow.test.ts src/pipeline/inbox-filing.ts \
  src/db/repo.ts src/mcp/tools/review-queue.ts \
  test/m2.tools.test.ts test/privacy-hardening.test.ts \
  agents/skills/review-triage.md agents/skills/RESOLVER.md
git commit -m "feat: complete inbox review and refiling through mcp"
```

**Acceptance:** the documented inspect/refile/drop loop is executable through audited MCP,
actor scoped, tier-2 fail-closed, and replay safe.

**Rollback:** keep migrations 023-024. The old `list|resolve` client shape remains valid; new
actions are additive.

---

### Task 5: Make onboarding context immediately searchable and state-visible

**Files:**

- Create: `src/search/index-structured.ts`
- Create: `test/onboard-indexing.test.ts`
- Modify: `src/onboard.ts`
- Modify: `fixtures/seed.ts`
- Modify: `src/mcp/tools/decisions.ts`
- Modify: `src/db/repo.ts`
- Modify: `src/mcp/tools/state.ts`
- Modify: `test/onboard.test.ts`
- Modify: `test/m3.search.test.ts`
- Modify: `test/m9.state-tz.test.ts`
- Modify: `agents/skills/morning-brief.md`
- Modify: `docs/GUIDE.md`

**Interfaces:**

```ts
export async function indexValue(input: {
  id: string;
  statement: string;
  priority: number;
  notes?: string | null;
  tier: 1 | 2;
}): Promise<number>;

export async function indexGoal(input: {
  id: string;
  statement: string;
  horizon: "life" | "year" | "quarter";
  why?: string | null;
  tier: 1 | 2;
}): Promise<number>;

export async function indexPrinciple(input: {
  id: string;
  rule: string;
  domain?: string | null;
  tier: 1 | 2;
}): Promise<number>;
```

State adds:

```ts
owner_context: {
  values: Array<{
    id: string;
    statement: string;
    priority: number;
    tier: 1 | 2;
  }>;
  active_goals: Array<{
    id: string;
    horizon: "life" | "year" | "quarter";
    statement: string;
    tier: 1 | 2;
  }>;
  principles: Array<{
    id: string;
    rule: string;
    domain: string | null;
    tier: 1 | 2;
  }>;
};
```

Tool output may omit `tier`; repository state uses it to prove/filter visibility.

- [ ] **Step 1: Write renderer and FTS RED tests**

With embedding mocked unavailable, assert exact parent types/IDs for one value, goal, and
principle. Assert the rendered text contains:

```text
# Value
Priority: <n>
<statement>
<notes when present>

# Goal: <statement>
Horizon: <horizon>
Why: <why when present>

# Principle
Domain: <domain when present>
<rule>
```

Reindexing one parent replaces its chunks rather than appending duplicates.

- [ ] **Step 2: Run indexing tests and observe RED**

```bash
bun test test/onboard-indexing.test.ts -t "FTS|render"
```

- [ ] **Step 3: Implement the three focused index wrappers**

Create `src/search/index-structured.ts`. Each wrapper renders the exact Markdown above and
calls:

```ts
indexParent(parentType, input.id, markdown, title, input.tier)
```

Use parent types `"value"`, `"goal"`, and `"principle"`. Do not generalize to every structured
table.

- [ ] **Step 4: Make structured inserts preserve tier**

In `src/db/repo.ts`, update `insertValueItem()`, `insertGoal()`, and `insertPrinciple()` to
include `tier` in their insert column/value lists, call `assertProseTier()`, and default to 1.
Their return shape remains `{ id: string }`.

- [ ] **Step 5: Transition onboarding call sites**

Change each onboarding insert from a discarded result to:

```ts
const { id } = await insertValueItem({ ... });
await indexValue({ id, statement, priority, tier: 1 });

const { id } = await insertGoal({ ... });
await indexGoal({ id, statement, horizon, why: null, tier: 1 });

const { id } = await insertPrinciple({ ... });
await indexPrinciple({ id, rule, domain: null, tier: 1 });
```

Keep profile/task/journal indexing unchanged.

- [ ] **Step 6: Transition seed and decision-principle call sites**

In `fixtures/seed.ts`, capture each returned ID and invoke the matching wrapper with the
inserted row's exact fields/tier. In `src/mcp/tools/decisions.ts`, replace its direct
`indexParent("principle", ...)` call with:

```ts
await indexPrinciple({
  id: principleId,
  rule: params.lesson,
  domain: null,
  tier: 1,
});
```

No other writer may directly render principle index text.

- [ ] **Step 7: Run search/onboarding GREEN tests**

```bash
bun test \
  test/onboard-indexing.test.ts \
  test/onboard.test.ts \
  test/m3.search.test.ts
```

- [ ] **Step 8: Write state visibility/source RED tests**

Immediately after onboarding, assert `minime_state.owner_context` contains the three inserted
IDs and the envelope includes source refs:

```text
value:<id>
goal:<id>
principle:<id>
```

Insert tier-2 structured rows. Locked actor output and sources omit their sentinels/IDs; the
same actor's live unlock reveals them.

- [ ] **Step 9: Add actor-filtered owner context to stateSnapshot()**

After `const allowed = await allowedTier(actor)`, add these queries to the existing
`Promise.all()`:

```sql
select id, statement, priority, tier
from values_items
where tier >= 1 and tier <= $allowed
order by priority, id

select id, horizon, statement, tier
from goals
where status = 'active' and tier >= 1 and tier <= $allowed
order by case horizon when 'life' then 1 when 'year' then 2 else 3 end, id

select id, rule, domain, tier
from principles
where tier >= 1 and tier <= $allowed
order by domain nulls last, id
```

Return them under `owner_context`.

- [ ] **Step 10: Add owner-context source refs**

In `src/mcp/tools/state.ts`, append source refs for each returned value, goal, and principle.
Do not create refs from rows filtered out by `stateSnapshot()`.

- [ ] **Step 11: Run state/privacy GREEN tests**

```bash
bun test \
  test/onboard-indexing.test.ts \
  test/m9.state-tz.test.ts \
  test/privacy-hardening.test.ts
```

- [ ] **Step 12: Update morning workflow documentation**

`agents/skills/morning-brief.md` reads `state.owner_context` before neutral search.
`docs/GUIDE.md` says values/goals/principles are available after onboarding only because the
tests above now prove search and state behavior.

- [ ] **Step 13: Commit the independently reviewable onboarding gate**

```bash
git add \
  src/search/index-structured.ts test/onboard-indexing.test.ts \
  src/onboard.ts fixtures/seed.ts src/mcp/tools/decisions.ts \
  src/db/repo.ts src/mcp/tools/state.ts test/onboard.test.ts \
  test/m3.search.test.ts test/m9.state-tz.test.ts \
  agents/skills/morning-brief.md docs/GUIDE.md
git commit -m "feat: surface onboarding context in search and state"
```

**Acceptance:** onboarding values/goals/principles are immediately discoverable in FTS-only
mode and visible through actor-tier-filtered state with source IDs.

**Rollback:** derived chunks may be rebuilt; source structured rows remain untouched.

---

### Task 6: Declare and share metric rollup semantics inside the existing pipeline

**Files:**

- Create: `db/migrations/025_metric_rollups.sql`
- Create: `src/pipeline/metric-rollup.ts`
- Create: `test/metric-rollup.test.ts`
- Modify: `src/db/repo.ts`
- Modify: `src/mcp/tools/metric.ts`
- Modify: `src/pipeline/dream.ts`
- Modify: `test/m1.schema.test.ts`
- Modify: `test/m2.tools.test.ts`
- Modify: `test/m6.leak.test.ts`
- Modify: `docs/SUBSYSTEMS.md`
- Modify: `docs/GUIDE.md`
- Modify: `DECISIONS.md`

**Subsystem placement:** `src/pipeline/metric-rollup.ts` is deterministic Dream job/metric
plumbing. It is added to the existing Dream job inventory row; this task must not create
a top-level metrics directory, a new subsystem row, or a new runtime dependency.

**Schema:**

```sql
alter table metric_defs
  add column rollup text not null default 'sum';
alter table metric_defs
  add constraint metric_defs_rollup_check
  check (rollup in ('sum', 'average', 'last', 'max'));
```

Migration 025:

- assigns `sum` to spend, sleep minutes, steps, and deep work;
- assigns `last` to `journal_streak`;
- updates streak SQL to consider all journal days through `$2`, then filters returned rows to
  `$1..$2`;
- deletes only incorrect derived `journal_streak` week/month rows;
- does not edit migration 006 or daily/source data.

**Interfaces:**

```ts
export type MetricRollup = "sum" | "average" | "last" | "max";

export interface MetricPoint {
  period_start: string;
  value: number;
  label: string | null;
}

export function rollupMetricRows(
  rows: readonly MetricPoint[],
  granularity: "day" | "week" | "month",
  rollup: MetricRollup,
): MetricPoint[];
```

Repository return types become:

```ts
export interface MetricDefinition {
  name: string;
  unit: string | null;
  description: string | null;
  agg_sql: string | null;
  rollup: MetricRollup;
}

export async function metricDef(name: string): Promise<MetricDefinition | null>;
export async function listMetricDefs(): Promise<MetricDefinition[]>;
```

- [ ] **Step 1: Write pure rollup RED tests**

Add these exact cases to `test/metric-rollup.test.ts`:

```text
streak 1,2,3 weekly + last → 3
spend 5,7 weekly + sum → 12
values 5,7 weekly + average → 6
values 5,7 weekly + max → 7
unsorted dates + last → chronologically last value
same dates with labels A/B → independent buckets
same date with label null and label "" → two independent buckets
Monday and Sunday → same ISO week; next Monday → next bucket
January 31 and February 1 → different month buckets
```

Expected output order is `period_start`, then `label` with null first.

- [ ] **Step 2: Run pure tests and observe RED**

```bash
bun test test/metric-rollup.test.ts -t "pure rollup"
```

Expected: fail because `src/pipeline/metric-rollup.ts` does not exist.

- [ ] **Step 3: Implement the pure helper**

Create `src/pipeline/metric-rollup.ts`. The implementation must:

1. validate `period_start` with `/^\d{4}-\d{2}-\d{2}$/`;
2. return a sorted copy for day granularity;
3. derive Monday-start ISO week or first-of-month keys in UTC;
4. group by `JSON.stringify([bucket, row.label])`, preserving null separately from `""`;
5. retain `sum`, `count`, `max`, and chronologically last `{date,value}`;
6. emit the selected rollup and deterministic order;
7. throw `INVALID_METRIC_ROLLUP` for an unrecognized runtime value.

- [ ] **Step 4: Run pure tests GREEN**

```bash
bun test test/metric-rollup.test.ts -t "pure rollup"
```

- [ ] **Step 5: Write schema/history RED tests**

Assert:

- all `metric_defs.rollup` values are in the four-value enum;
- `journal_streak.rollup === "last"` and all current additive definitions are `"sum"`;
- a query whose `from` is day three of an existing three-day streak returns value 3;
- invalid rollup insert/update is rejected by the named check;
- migration 006 remains byte-unchanged in this task;
- no day-granularity `journal_streak` row is removed by migration 025.

- [ ] **Step 6: Create migration 025**

Add the column/check, update definitions explicitly by name, replace only
`journal_streak.agg_sql`, and execute:

```sql
delete from metric_values
where metric = 'journal_streak'
  and granularity in ('week', 'month');
```

The corrected streak SQL computes islands from every distinct journal date `<= $2`, then its
outer select applies `period_start between $1 and $2`. This preserves history before `$1`
while returning only the requested window.

- [ ] **Step 7: Expose rollup through repository definitions**

Update both selects in `metricDef()` and `listMetricDefs()` to return:

```sql
name, unit, description, agg_sql, rollup
```

Decode `rollup` with an exhaustive runtime guard before returning `MetricDefinition`.

- [ ] **Step 8: Run schema/history tests GREEN**

```bash
bun test test/metric-rollup.test.ts -t "schema|history"
bun test test/m1.schema.test.ts
```

- [ ] **Step 9: Transition the live metric call site**

In `src/mcp/tools/metric.ts`:

- remove local `truncate()`;
- import `rollupMetricRows` from `../../pipeline/metric-rollup`;
- replace the hand-built unconditional-sum map with:

```ts
const rolled = rollupMetricRows(daily, granularity, def.rollup);
const series = rolled.map((row) => ({
  period_start: row.period_start,
  value: row.value,
  ...(row.label === null ? {} : { label: row.label }),
}));
```

Keep day persistence for dimensionless metrics unchanged.

- [ ] **Step 10: Verify live metric behavior**

```bash
bun test test/metric-rollup.test.ts -t "live"
bun test test/m2.tools.test.ts
```

- [ ] **Step 11: Transition the dream call site**

In `src/pipeline/dream.ts`, delete the weekly/monthly sum maps. For each dimensionless
definition:

```ts
for (const row of rollupMetricRows(daily, "week", def.rollup)) {
  await upsertMetricValue(def.name, row.period_start, "week", row.value, "dream");
}
for (const row of rollupMetricRows(daily, "month", def.rollup)) {
  await upsertMetricValue(def.name, row.period_start, "month", row.value, "dream");
}
```

Day persistence stays as it is. Labeled metrics remain live-only.

- [ ] **Step 12: Write and run live/dream equivalence GREEN tests**

For the same daily fixture and definition, assert query response rows and stored dream
week/month rows are byte-equivalent after normalizing numeric database values.

```bash
bun test \
  test/metric-rollup.test.ts \
  test/m2.tools.test.ts \
  test/m6.leak.test.ts
```

- [ ] **Step 13: Update subsystem inventory and correction record**

In `docs/SUBSYSTEMS.md`, extend the existing Dream job path cell to include
`src/pipeline/metric-rollup.ts` and cite `test/metric-rollup.test.ts` as maintenance evidence.
Do not add a subsystem row.

Append a `DECISIONS.md` entry that `journal_streak` is a period-end state (`last`), while the
listed flow metrics remain additive (`sum`). Update `docs/GUIDE.md` with that reader-facing
meaning.

- [ ] **Step 14: Run final S4 gates**

```bash
bun test \
  test/inbox-tier-policy.test.ts \
  test/inbox-paths.test.ts \
  test/inbox-filing-service.test.ts \
  test/inbox-rollback.test.ts \
  test/inbox-review-workflow.test.ts \
  test/onboard-indexing.test.ts \
  test/metric-rollup.test.ts
make check-subsystems
make verify
git diff --check
```

- [ ] **Step 15: Commit the metric gate**

```bash
git add \
  db/migrations/025_metric_rollups.sql \
  src/pipeline/metric-rollup.ts test/metric-rollup.test.ts \
  src/db/repo.ts src/mcp/tools/metric.ts src/pipeline/dream.ts \
  test/m1.schema.test.ts test/m2.tools.test.ts test/m6.leak.test.ts \
  docs/SUBSYSTEMS.md docs/GUIDE.md DECISIONS.md
git commit -m "fix: make metric rollups explicit"
```

**Acceptance:** live and persisted results use one declared implementation; a three-day
journal streak reports 3, not 6; subsystem inventory covers the helper without inventing a
new top-level subsystem.

**Rollback:** keep migration 025 applied. Old code ignores the additive column and may
temporarily sum streaks incorrectly; returning to corrected code regenerates derived
week/month rows. Daily/source data remains intact.

---

## S4 Acceptance and Rollback

Acceptance:

- Migration numbers remain 023-025 and follow S1 migrations 021-022.
- Existing, defaulted, current-binary, and old-binary raw inbox writes all store tier 2.
- Same-basename captures and same-title notes preserve separate immutable data.
- Automatic filing and actor-unlocked review use one recoverable service.
- Locked actors neither list tier-2 inbox review items nor inspect/refile their raw content.
- Onboarded values/goals/principles are searchable in FTS-only mode and visible in
  actor-filtered state.
- Live and persisted metric rollups import `src/pipeline/metric-rollup.ts`.
- `make check-subsystems`, `make verify`, and `git diff --check` are green.

Rollback:

- Migrations 023-025 remain applied.
- Migration 023's tier normalizer remains active so one-release old binaries can still
  capture without weakening raw inbox tier.
- Before an old-binary downgrade, stop writers and run the committed
  `requeue-stale-inbox-filings` repair; zero remaining `filing` rows is a hard gate.
- Never delete or rename immutable archive files during rollback.
- New review actions are additive; old `list|resolve` tool clients remain valid.
- Source rows and daily metrics remain untouched.
